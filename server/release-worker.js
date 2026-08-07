import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const RELEASE_MARKER = /\[released:([^\]]+)\]/g
const BLOCKED_MARKER = /\[release-blocked:([^\]]+)\]/g
const SENTINEL_MARKER = /\[sentinel:[0-9a-f]{12}\]/
const MAX_RELEASE_ATTEMPTS = 3

export const defaultRepoPlan = {
  gba_console: {
    branch: 'main',
    root: '/root/projects/gba_console',
    services: ['gba-console'],
    checks: [
      ['npx', 'vitest', 'run', '--silent'],
      ['npm', 'run', 'build'],
    ],
  },
  'gba-server': {
    branch: 'development',
    root: '/root/projects/gba-server',
    services: ['data-concord', 'data-analytics'],
    checks: [
      ['dotnet', 'build', 'src/Global.Business.Assistant.Api/Global.Business.Assistant.Api.csproj', '-v', 'q', '--nologo'],
      ['dotnet', 'test', 'tests/Global.Business.Assistant.Platform.Actors.Tests/Global.Business.Assistant.Platform.Actors.Tests.csproj', '-v', 'q', '--nologo'],
      ['dotnet', 'test', 'tests/Global.Business.Assistant.Domain.Tests/Global.Business.Assistant.Domain.Tests.csproj', '-v', 'q', '--nologo'],
    ],
  },
  gba_ecommerce: {
    branch: 'development',
    root: '/root/projects/gba_ecommerce',
    services: ['gba-ecommerce'],
    checks: [
      ['npx', 'vitest', 'run', '--silent'],
      ['npx', 'next', 'build'],
    ],
  },
  'gba-ecommerce-api': {
    branch: 'development',
    root: '/root/projects/gba-ecommerce-api',
    services: ['gba-ecommerce-api'],
    checks: [
      ['dotnet', 'build', 'src/GBA.Ecommerce/GBA.Ecommerce.csproj', '-v', 'q', '--nologo'],
      ['dotnet', 'test', 'tests/GBA.Ecommerce.Api.Tests/GBA.Ecommerce.Api.Tests.csproj', '-v', 'q', '--nologo'],
    ],
  },
}

export function taskSlug(taskId) {
  return taskId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')
}

export function branchName(taskId) {
  return `codex/qa-${taskSlug(taskId)}`
}

function latestMarkerAt(notes, marker) {
  let found = false
  let newest = null
  for (const match of (notes ?? '').matchAll(marker)) {
    found = true
    // Стамп пишеться як «YYYY-MM-DD HH:MM» у UTC (зріз ISO), тож читаємо його як UTC.
    const parsed = Date.parse(`${match[1].trim().slice(0, 16).replace(' ', 'T')}:00Z`)
    if (!Number.isNaN(parsed) && (newest === null || parsed > newest)) newest = parsed
  }
  // Мітка без читабельного часу (старий або зіпсований формат) має лишатись
  // бар'єром назавжди — інакше одна крива нотатка відкриє задачу на перевипуск.
  if (found && newest === null) return Number.POSITIVE_INFINITY
  return newest
}

export function isReleased(task) {
  return latestMarkerAt(task.notes, RELEASE_MARKER) !== null
}

/**
 * Коли конвеєр востаннє «закрив» задачу — випуском або через впертий провал.
 * Друга спроба Codex після релізу раніше лишалась у worktree назавжди: мітка
 * [released:...] назавжди виключала задачу з вибірки, хоч робота була нова.
 */
export function lastGateAt(task) {
  const released = latestMarkerAt(task.notes, RELEASE_MARKER)
  const blocked = latestMarkerAt(task.notes, BLOCKED_MARKER)
  if (released === null) return blocked
  if (blocked === null) return released
  return Math.max(released, blocked)
}

export function hasWorkNewerThanGate(task) {
  const gate = lastGateAt(task)
  if (gate === null) return true
  const finishedAt = Date.parse(task.agentRun?.finishedAt ?? task.agentRun?.updatedAt ?? '')
  return !Number.isNaN(finishedAt) && finishedAt > gate
}

const SANDBOX_LIMIT_PATTERNS = [
  /пісочниц/i,
  /\bsandbox\b/i,
  /\b(?:vstest|testhost)\b/i,
  /loopback/i,
  /test artifacts/i,
  /\bbwrap\b/i,
  /no permissions to create a new namespace/i,
  /(?:відсутн\w*|немає|не встановлен\w*|missing|not (?:found|installed))[^.\n]{0,60}\.net sdk/i,
  /\.net sdk[^.\n]{0,60}(?:відсутн\w*|немає|не встановлен\w*|missing|not (?:found|installed))/i,
  /dotnet[^.\n]{0,40}(?:command not found|not found|немає|відсутн\w*)/i,
]

export function isSandboxLimitedReview(task) {
  const run = task.agentRun
  if (!run || run.status !== 'needs_review') return false
  const text = `${run.summary ?? ''}\n${run.error ?? ''}`
  return SANDBOX_LIMIT_PATTERNS.some((pattern) => pattern.test(text))
}

export function isSentinelTask(task) {
  return SENTINEL_MARKER.test(task.notes ?? '') || /^\[AUTO\]/.test(task.title ?? '')
}

export function releaseStatusFor(task) {
  return isSentinelTask(task) ? 'done' : 'ready_for_retest'
}

export function selectReleasableTasks(tasks) {
  return tasks.filter((task) =>
    (task.agentRun?.status === 'completed' || isSandboxLimitedReview(task)) &&
    hasWorkNewerThanGate(task) &&
    task.status !== 'done')
}

export function parseUnitStates(output) {
  const units = {}
  let currentId = null
  for (const line of (output ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('Id=')) {
      currentId = trimmed.slice(3)
      continue
    }
    if (trimmed.startsWith('ActiveState=') && currentId) {
      units[currentId] = trimmed.slice('ActiveState='.length)
      currentId = null
    }
  }
  return units
}

function runProcess(command, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output = (output + chunk.toString()).slice(-20000) })
    child.stderr.on('data', (chunk) => { output = (output + chunk.toString()).slice(-20000) })
    child.on('error', (error) => resolve({ code: 1, output: String(error) }))
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

async function pathExists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

export class ReleaseWorker {
  constructor({
    deskBaseUrl = process.env.RELEASE_DESK_URL ?? 'http://127.0.0.1:4000',
    worktreesDirectory = process.env.CODEX_WORKTREES_DIR ?? '/root/projects/gba-bug-worktrees',
    infraDirectory = process.env.RELEASE_INFRA_DIR ?? '/root/projects/gba-infra',
    repoPlan = defaultRepoPlan,
    pollIntervalMs = Number.parseInt(process.env.RELEASE_POLL_INTERVAL_MS ?? '30000', 10),
    settleMs = Number.parseInt(process.env.RELEASE_SETTLE_MS ?? '180000', 10),
    heartbeatIntervalMs = Number.parseInt(process.env.RELEASE_HEARTBEAT_INTERVAL_MS ?? '30000', 10),
  } = {}) {
    this.deskBaseUrl = deskBaseUrl.replace(/\/$/, '')
    this.worktreesDirectory = worktreesDirectory
    this.infraDirectory = infraDirectory
    this.repoPlan = repoPlan
    this.pollIntervalMs = pollIntervalMs
    this.settleMs = settleMs
    this.heartbeatIntervalMs = heartbeatIntervalMs
    this.busy = false
    this.firstSeenAt = new Map()
    this.failures = new Map()
  }

  start() {
    setInterval(() => void this.tick(), this.pollIntervalMs)
    void this.tick()
    setInterval(() => void this.reportHostUnits(), this.heartbeatIntervalMs)
    void this.reportHostUnits()
    console.log('[release] воркер запущено: completed → merge → тести → push → deploy')
  }

  async reportHostUnits() {
    // Список юнітів диктує інвентар дески: systemctl-глоб бачить лише завантажені
    // юніти, тож вимкнений таймер через глоб просто зникає замість «inactive».
    const wanted = await fetch(`${this.deskBaseUrl}/api/system/units`)
      .then((response) => response.json())
      .then((payload) => payload?.units ?? [])
      .catch(() => [])
    if (wanted.length === 0) return

    const shown = await runProcess(
      'systemctl',
      ['show', '--no-pager', '--property=Id', '--property=ActiveState', ...wanted],
      {},
    )
    if (shown.code !== 0) return
    const units = parseUnitStates(shown.output)
    if (Object.keys(units).length === 0) return
    await fetch(`${this.deskBaseUrl}/api/system/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ units, host: 'gba-host' }),
    }).catch((error) => console.error(`[release] heartbeat: ${error.message}`))
  }

  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      const response = await fetch(`${this.deskBaseUrl}/api/tasks`)
      if (!response.ok) throw new Error(`desk → ${response.status}`)
      const candidates = selectReleasableTasks(await response.json())
      if (candidates.length === 0) {
        this.firstSeenAt.clear()
        return
      }

      const now = Date.now()
      for (const task of candidates) {
        if (!this.firstSeenAt.has(task.id)) this.firstSeenAt.set(task.id, now)
      }
      const ready = candidates.filter((task) => now - this.firstSeenAt.get(task.id) >= this.settleMs)
      if (ready.length === 0) return
      if (ready.length < candidates.length) return

      await this.releaseBatch(ready)
      for (const task of ready) this.firstSeenAt.delete(task.id)
    } catch (error) {
      console.error(`[release] tick: ${error.message}`)
    } finally {
      this.busy = false
    }
  }

  async releaseBatch(tasks) {
    const touchedRepos = new Set()
    const released = []

    for (const task of tasks) {
      const outcome = await this.releaseTask(task)
      if (outcome.ok) {
        released.push({ task, alreadyMerged: Boolean(outcome.alreadyMerged) })
        for (const repo of outcome.repos) touchedRepos.add(repo)
      } else {
        // Конфлікт мерджу не розсмокчеться сам: без цього лічильника задача
        // ретраїлась кожні 3.5 хв нескінченно й засипала нотатки [release-fail].
        const attempts = (this.failures.get(task.id) ?? 0) + 1
        this.failures.set(task.id, attempts)
        if (attempts >= MAX_RELEASE_ATTEMPTS) {
          const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
          await this.annotate(task, `[release-blocked:${stamp}] ${attempts} невдалих спроб: ${outcome.reason}. Потрібна людина або новий прогін Codex.`.slice(0, 500))
          await this.setStatus(task, 'blocked')
          this.failures.delete(task.id)
          console.error(`[release] ${task.id}: заблоковано після ${attempts} спроб — ${outcome.reason.slice(0, 160)}`)
        } else {
          await this.annotate(task, `[release-fail] ${outcome.reason}`.slice(0, 500))
          console.error(`[release] ${task.id}: ${outcome.reason.slice(0, 200)}`)
        }
      }
    }

    if (touchedRepos.size > 0) {
      const services = [...touchedRepos].flatMap((repo) => this.repoPlan[repo].services)
      const deploy = await runProcess(
        'docker',
        ['compose', '-p', 'gba-dev', '-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml', '--env-file', '.env.dev', 'up', '-d', '--build', ...services],
        { cwd: this.infraDirectory },
      )
      if (deploy.code !== 0) {
        console.error(`[release] deploy failed: ${deploy.output.slice(-300)}`)
        for (const { task } of released) await this.annotate(task, '[release-fail] деплой не пройшов, код у логах release-воркера')
        return
      }
      console.log(`[release] задеплоєно: ${services.join(', ')}`)
    }

    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
    for (const { task, alreadyMerged } of released) {
      const status = releaseStatusFor(task)
      const closing = status === 'done'
      await this.annotate(task, [
        alreadyMerged
          ? `[released:${stamp}] гілки вже були влиті вручну`
          : `[released:${stamp}] змерджено і задеплоєно на dev`,
        closing ? '[auto-closed] лог-задача: фікс у мейнлайні й на dev; якщо помилка повториться — вартовий заведе нову' : '',
      ].filter(Boolean).join('\n'))
      if (task.status !== status) await this.setStatus(task, status)
      console.log(`[release] ${task.id}: випущено${alreadyMerged ? ' (вже було влито)' : ''}${closing ? ' і закрито' : ''}`)
    }
  }

  async releaseTask(task) {
    const slug = taskSlug(task.id)
    const branch = branchName(task.id)
    const jobDirectory = path.join(this.worktreesDirectory, slug)
    const repos = []

    for (const [repo, plan] of Object.entries(this.repoPlan)) {
      const worktree = path.join(jobDirectory, repo)
      if (!(await pathExists(path.join(worktree, '.git')))) continue

      const status = await runProcess('git', ['-C', worktree, 'status', '--porcelain'], {})
      if (status.output.split('\n').some((line) => line.trim())) {
        const stage = await runProcess('git', ['-C', worktree, 'add', '-A'], {})
        if (stage.code !== 0) return { ok: false, reason: `stage у ${repo}: ${stage.output.slice(-200)}` }
        const commit = await runProcess('git', ['-C', worktree, 'commit', '-m', `fix: ${task.title.slice(0, 90)} (${task.id})\n\nCo-Authored-By: Codex via GBA QA Desk`], {})
        if (commit.code !== 0) return { ok: false, reason: `commit у ${repo}: ${commit.output.slice(-200)}` }
      }

      const diff = await runProcess('git', ['-C', plan.root, 'rev-list', '--count', `${plan.branch}..${branch}`], {})
      if (diff.code !== 0 || diff.output.trim() === '0') continue
      repos.push(repo)
    }

    if (repos.length === 0) return { ok: true, repos: [], alreadyMerged: true }

    for (const repo of repos) {
      const plan = this.repoPlan[repo]

      const dirty = await runProcess('git', ['-C', plan.root, 'status', '--porcelain'], {})
      if (dirty.output.split('\n').some((line) => line && !line.startsWith('??'))) {
        return { ok: false, reason: `${repo}: у робочому дереві є незакомічені зміни — відкладено` }
      }

      const baseline = await runProcess('git', ['-C', plan.root, 'rev-parse', 'HEAD'], {})
      const baselineCommit = /\b[0-9a-f]{40}\b/.exec(baseline.output)?.[0]
      if (!baselineCommit) return { ok: false, reason: `${repo}: не вдалося зафіксувати HEAD перед мерджем` }

      const merge = await runProcess('git', ['-C', plan.root, 'merge', '--no-edit', branch], {})
      if (merge.code !== 0) {
        await runProcess('git', ['-C', plan.root, 'merge', '--abort'], {})
        return { ok: false, reason: `${repo}: конфлікт мерджу з ${branch}` }
      }

      for (const check of plan.checks) {
        const result = await runProcess(check[0], check.slice(1), { cwd: plan.root })
        if (result.code !== 0) {
          await runProcess('git', ['-C', plan.root, 'reset', '--hard', baselineCommit], {})
          return { ok: false, reason: `${repo}: перевірка «${check.join(' ')}» впала; мердж відкочено` }
        }
      }

      const push = await runProcess('git', ['-C', plan.root, 'push', 'origin', plan.branch], {})
      if (push.code !== 0) return { ok: false, reason: `${repo}: push не пройшов: ${push.output.slice(-200)}` }
    }

    return { ok: true, repos }
  }

  async setStatus(task, status) {
    await fetch(`${this.deskBaseUrl}/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }).catch(() => undefined)
  }

  async annotate(task, line) {
    const fresh = await fetch(`${this.deskBaseUrl}/api/tasks`).then((r) => r.json()).catch(() => null)
    const current = fresh?.find((item) => item.id === task.id)
    const notes = `${(current ?? task).notes ?? ''}\n${line}`.slice(0, 9900)
    await fetch(`${this.deskBaseUrl}/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    }).catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  new ReleaseWorker().start()
  setInterval(() => {}, 60_000)
}
