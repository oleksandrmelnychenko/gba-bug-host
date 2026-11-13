import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const RUN_MARKER_PATTERN = /\[sentinel-run:([a-z0-9-]+)\] run:(\S+)/

export const DEFAULT_RUN_STATES = [
  '/host-state/gba-sync/latest.json|sync|Нічна синхронізація 1С|gba-sync@light.service',
  '/host-state/gba-ai-fleet/latest.json|fleet|Щоденний цикл AI-флоту|gba-ai-fleet-refresh.service',
].join('~~')

export function parseRunStateSpec(value) {
  return (value ?? '')
    .split('~~')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [file, kind, label, unit] = item.split('|').map((part) => part.trim())
      return { file, kind, key: kind, label: label || kind, unit: unit || '' }
    })
    .filter((source) => source.file && (source.kind === 'sync' || source.kind === 'fleet'))
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function syncDetails(payload) {
  const details = []
  if (text(payload.mode)) details.push(`Режим: ${payload.mode}`)
  if (Number.isInteger(payload.exit)) details.push(`Код виходу: ${payload.exit}`)
  for (const [name, base] of Object.entries(payload.bases ?? {})) {
    if (base?.ok === true) continue
    const reason = text(base?.reason) || text(base?.status) || 'failed'
    details.push(`База ${name}: ${reason}${text(base?.failedStep) ? ` (крок ${base.failedStep})` : ''}`)
  }
  for (const [name, ok] of Object.entries(payload.downstream ?? {})) {
    if (ok !== true) details.push(`Не оновлено: ${name}`)
  }
  for (const problem of payload.preflight_problems ?? []) details.push(`Передстартова перевірка: ${problem}`)
  return details
}

function fleetDetails(payload) {
  const details = []
  if (text(payload.cycle_date)) details.push(`Цикл: ${payload.cycle_date}`)
  if ((payload.failed_stages ?? []).length > 0) details.push(`Незавершені етапи: ${payload.failed_stages.join(', ')}`)
  if ((payload.failed_services ?? []).length > 0) details.push(`Нездорові сервіси: ${payload.failed_services.join(', ')}`)
  for (const [name, stage] of Object.entries(payload.stages ?? {})) {
    if (stage?.status === 'failed' && text(stage.error)) details.push(`Етап ${name}: ${stage.error.slice(0, 400)}`)
  }
  return details
}

export function readRunOutcome(kind, payload) {
  if (!payload || typeof payload !== 'object') return null
  if (kind === 'sync') {
    const runId = text(payload.run)
    if (!runId || typeof payload.ok !== 'boolean') return null
    return {
      runId,
      state: payload.ok ? 'ok' : 'failed',
      failure: text(payload.failure) || 'запуск не завершився успішно',
      at: text(payload.finished_at),
      details: payload.ok ? [] : syncDetails(payload),
    }
  }
  if (kind === 'fleet') {
    const runId = text(payload.run_id)
    if (!runId) return null
    const state = payload.status === 'complete' ? 'ok' : payload.status === 'failed' ? 'failed' : 'pending'
    return {
      runId,
      state,
      failure: text(payload.failure) || 'цикл не завершився успішно',
      at: text(payload.failed_at) || text(payload.completed_at) || text(payload.started_at),
      details: state === 'failed' ? fleetDetails(payload) : [],
    }
  }
  return null
}

export function runMarker(task) {
  const match = RUN_MARKER_PATTERN.exec(task?.notes ?? '')
  return match ? { key: match[1], runId: match[2] } : null
}

export function buildRunTaskDraft(source, outcome, buildTag, now = new Date()) {
  const compact = outcome.failure.replace(/\s+/g, ' ').slice(0, 90)
  return {
    title: `[AUTO] ${source.label}: запуск не вдався — ${compact}`.slice(0, 140),
    description: [
      `Автоматично зафіксовано вартовим за файлом стану ${source.file}.`,
      `Останній запуск ${outcome.runId} завершився помилкою${outcome.at ? ` (${outcome.at})` : ''}:`,
      outcome.failure.slice(0, 2000),
      'Задача оновлюється при кожному наступному невдалому запуску і закривається автоматично після першого успішного.',
    ].join('\n'),
    project: 'console',
    area: `Регламентні запуски / ${source.label}`.slice(0, 80),
    priority: 'high',
    status: 'new',
    aiMode: 'off',
    notes: [
      `[sentinel-run:${source.key}] run:${outcome.runId} build:${buildTag}`,
      ...(source.unit ? [`Юніт: ${source.unit} (journalctl -u ${source.unit})`] : []),
      `Зафіксовано: ${now.toISOString()}`,
      '',
      'Причина:',
      outcome.failure,
      ...outcome.details,
    ].join('\n').slice(0, 9800),
  }
}

export class RunStateSentinel {
  constructor({
    deskBaseUrl = process.env.SENTINEL_DESK_URL ?? 'http://127.0.0.1:4000',
    dataDirectory = process.env.DATA_DIR ?? path.join(process.cwd(), 'data'),
    sources = parseRunStateSpec(process.env.SENTINEL_RUN_STATES ?? DEFAULT_RUN_STATES),
    pollMs = Number.parseInt(process.env.SENTINEL_RUN_POLL_MS ?? '60000', 10),
    buildTag = process.env.APP_BUILD_NUMBER ?? 'local',
    internalApiToken = process.env.QA_DESK_INTERNAL_API_TOKEN ?? '',
  } = {}) {
    this.deskBaseUrl = deskBaseUrl.replace(/\/$/, '')
    this.statePath = path.join(dataDirectory, 'run-sentinel-state.json')
    this.sources = sources
    this.pollMs = pollMs
    this.buildTag = buildTag
    this.internalApiToken = internalApiToken
    this.state = { runs: {} }
    this.readProblems = {}
  }

  requestHeaders(extra = {}) {
    return this.internalApiToken ? { Authorization: `Bearer ${this.internalApiToken}`, ...extra } : extra
  }

  async start() {
    if (this.sources.length === 0) return
    await mkdir(path.dirname(this.statePath), { recursive: true })
    try {
      this.state = { runs: {}, ...JSON.parse(await readFile(this.statePath, 'utf8')) }
    } catch {
      this.state = { runs: {} }
    }
    for (const source of this.sources) console.log(`[sentinel] стежу за результатом запусків: ${source.label} (${source.file})`)
    const poll = () => void this.pollOnce().catch((error) => console.error(`[sentinel] запуски: ${error.message}`))
    poll()
    setInterval(poll, this.pollMs).unref?.()
  }

  async pollOnce() {
    const results = []
    for (const source of this.sources) {
      try {
        results.push(await this.check(source))
      } catch (error) {
        console.error(`[sentinel] ${source.label}: ${error.message}`)
        results.push('error')
      }
    }
    return results
  }

  async readSource(source) {
    try {
      const payload = JSON.parse(await readFile(source.file, 'utf8'))
      delete this.readProblems[source.key]
      return payload
    } catch (error) {
      const problem = error.code ?? error.name
      if (this.readProblems[source.key] !== problem) {
        console.error(`[sentinel] ${source.label}: файл стану не прочитано (${problem})`)
        this.readProblems[source.key] = problem
      }
      return null
    }
  }

  async check(source) {
    const outcome = readRunOutcome(source.kind, await this.readSource(source))
    if (!outcome) return 'unreadable'
    if (outcome.state === 'pending') return 'pending'

    const known = this.state.runs[source.key]
    if (known?.runId === outcome.runId && known.state === outcome.state && known.settled) return 'unchanged'

    const tasks = await this.listTasks()
    const openTask = tasks.find((task) => task.status !== 'done' && runMarker(task)?.key === source.key) ?? null

    if (outcome.state === 'ok') {
      if (openTask) {
        const closing = `\n\nАвтоматично закрито ${new Date().toISOString()}: запуск ${outcome.runId} успішний${outcome.at ? ` (${outcome.at})` : ''}.`
        await this.patchDeskTask(openTask.id, {
          status: 'done',
          notes: `${(openTask.notes ?? '').slice(0, 9800 - closing.length)}${closing}`,
        })
        console.log(`[sentinel] ${source.label}: запуск ${outcome.runId} успішний — закрито ${openTask.id}`)
      }
      await this.remember(source, outcome, null)
      return openTask ? 'closed' : 'ok'
    }

    const draft = buildRunTaskDraft(source, outcome, this.buildTag)
    if (openTask) {
      if (runMarker(openTask).runId === outcome.runId) {
        await this.remember(source, outcome, openTask.id)
        return 'unchanged'
      }
      const previousRuns = (known?.taskId === openTask.id ? known.failedRuns ?? 1 : 1) + 1
      await this.patchDeskTask(openTask.id, {
        title: draft.title,
        description: draft.description,
        notes: `${draft.notes}\n\nНевдалих запусків поспіль: ${previousRuns}`.slice(0, 9800),
      })
      await this.remember(source, outcome, openTask.id, previousRuns)
      console.log(`[sentinel] ${source.label}: запуск ${outcome.runId} знову невдалий — оновлено ${openTask.id}`)
      return 'updated'
    }

    const closedForRun = tasks.find((task) => {
      const marker = runMarker(task)
      return marker?.key === source.key && marker.runId === outcome.runId
    })
    if (closedForRun) {
      await this.remember(source, outcome, closedForRun.id)
      return 'unchanged'
    }

    const task = await this.createDeskTask(draft)
    await this.remember(source, outcome, task.id)
    console.log(`[sentinel] ${source.label}: запуск ${outcome.runId} невдалий — створено ${task.id}`)
    return 'created'
  }

  async remember(source, outcome, taskId, failedRuns = 1) {
    this.state.runs[source.key] = {
      runId: outcome.runId,
      state: outcome.state,
      settled: true,
      ...(taskId ? { taskId, failedRuns } : {}),
    }
    await this.saveState()
  }

  async listTasks() {
    const response = await fetch(`${this.deskBaseUrl}/api/tasks`, { headers: this.requestHeaders() })
    if (!response.ok) throw new Error(`desk /api/tasks → ${response.status}`)
    return response.json()
  }

  async createDeskTask(draft) {
    const body = new FormData()
    for (const [key, value] of Object.entries(draft)) body.set(key, value)
    const response = await fetch(`${this.deskBaseUrl}/api/tasks`, { method: 'POST', headers: this.requestHeaders(), body })
    if (!response.ok) throw new Error(`desk create → ${response.status}: ${(await response.text()).slice(0, 200)}`)
    return response.json()
  }

  async patchDeskTask(taskId, patch) {
    const response = await fetch(`${this.deskBaseUrl}/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      headers: this.requestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(patch),
    })
    if (!response.ok) throw new Error(`desk patch ${taskId} → ${response.status}: ${(await response.text()).slice(0, 200)}`)
    return response.json()
  }

  async saveState() {
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf8')
  }
}
