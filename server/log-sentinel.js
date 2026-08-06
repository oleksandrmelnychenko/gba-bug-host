import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MARKER_PATTERN = /\[sentinel:([0-9a-f]{12})\]/

export function normalizeForFingerprint(text) {
  return text
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.,:0-9Z+-]*/g, '<ts>')
    .replace(/\b\d{2}:\d{2}:\d{2}[.,]\d+\b/g, '<ts>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<guid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/0x[0-9A-Fa-f]+/g, '<hex>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function fingerprintGroup(containerName, lines) {
  const significant = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .map(normalizeForFingerprint)
    .join('\n')
  return createHash('sha1').update(`${containerName}\n${significant}`).digest('hex').slice(0, 12)
}

export function isContinuationLine(line) {
  if (/^\s/.test(line)) return true
  return /^(at |Caused by|--->?|System\.|Microsoft\.|GBA\.|Global\.|Akka\.|Npgsql\.|Elastic|[})\]]|\.{3}|Error:|TypeError|ReferenceError|Object |innerException)/i.test(line)
}

export class ErrorGroupCollector {
  constructor({ matcher, ignore = [], maxLines = 40, quietMs = 1200, onGroup }) {
    this.matcher = matcher
    this.ignore = ignore
    this.maxLines = maxLines
    this.quietMs = quietMs
    this.onGroup = onGroup
    this.pending = null
    this.timer = null
  }

  feed(line) {
    if (this.pending) {
      if (this.pending.length < this.maxLines && isContinuationLine(line)) {
        this.pending.push(line)
        this.armTimer()
        return
      }
      this.flush()
    }

    if (!this.matcher.test(line)) return
    if (this.ignore.some((pattern) => pattern.test(line))) return
    this.pending = [line]
    this.armTimer()
  }

  armTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.quietMs)
    this.timer.unref?.()
  }

  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.pending) return
    const group = this.pending
    this.pending = null
    if (this.ignore.some((pattern) => group.some((line) => pattern.test(line)))) return
    this.onGroup(group)
  }
}

export function parseContainerSpec(value) {
  return (value ?? '')
    .split('~~')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [name, project, ...labelParts] = item.split('|')
      return {
        name: name?.trim(),
        project: (project ?? 'console').trim() || 'console',
        label: labelParts.join('|').trim() || name?.trim() || 'unknown',
      }
    })
    .filter((container) => Boolean(container.name))
}

export function parseIgnorePatterns(value) {
  return (value ?? '')
    .split('~~')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((pattern) => new RegExp(pattern))
}

export function buildTaskDraft(container, lines, fingerprint, buildTag) {
  const firstLine = lines.find((line) => line.trim()) ?? 'Невідома помилка'
  const compact = normalizeForFingerprint(firstLine).slice(0, 96)
  const excerpt = lines.join('\n').slice(0, 8000)

  return {
    title: `[AUTO] ${container.label}: ${compact}`.slice(0, 140),
    description: `Автоматично зафіксовано вартовим логів у контейнері ${container.name}. Перший запис:\n${firstLine.slice(0, 2500)}`,
    project: container.project,
    area: `Логи / ${container.label}`.slice(0, 80),
    priority: 'high',
    status: 'new',
    notes: [
      `[sentinel:${fingerprint}] build:${buildTag}`,
      `Контейнер: ${container.name}`,
      `Зафіксовано: ${new Date().toISOString()}`,
      '',
      'Витяг логів:',
      excerpt,
    ].join('\n').slice(0, 9800),
  }
}

function demuxDockerStream(onLine) {
  let buffer = Buffer.alloc(0)
  let textCarry = ''
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 8) {
      const frameSize = buffer.readUInt32BE(4)
      if (buffer.length < 8 + frameSize) break
      textCarry += buffer.subarray(8, 8 + frameSize).toString('utf8')
      buffer = buffer.subarray(8 + frameSize)
      let index
      while ((index = textCarry.indexOf('\n')) >= 0) {
        onLine(textCarry.slice(0, index).replace(/\r$/, ''))
        textCarry = textCarry.slice(index + 1)
      }
    }
  }
}

function rawLineStream(onLine) {
  let textCarry = ''
  return (chunk) => {
    textCarry += chunk.toString('utf8')
    let index
    while ((index = textCarry.indexOf('\n')) >= 0) {
      onLine(textCarry.slice(0, index).replace(/\r$/, ''))
      textCarry = textCarry.slice(index + 1)
    }
  }
}

export class LogSentinel {
  constructor({
    dockerSocket = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    deskBaseUrl = process.env.SENTINEL_DESK_URL ?? 'http://127.0.0.1:4000',
    triggerToken = process.env.CODEX_TRIGGER_TOKEN ?? '',
    dataDirectory = process.env.DATA_DIR ?? path.join(process.cwd(), 'data'),
    containers = parseContainerSpec(process.env.SENTINEL_CONTAINERS),
    ignore = parseIgnorePatterns(process.env.SENTINEL_IGNORE),
    matcher = new RegExp(process.env.SENTINEL_MATCH ?? '\\bERROR\\b|\\bFATAL\\b|Unhandled|Unobserved|Exception|Traceback|⨯'),
    maxTasksPerHour = Number.parseInt(process.env.SENTINEL_MAX_PER_HOUR ?? '4', 10),
    recurCooldownMs = Number.parseInt(process.env.SENTINEL_RECUR_COOLDOWN_MS ?? String(6 * 60 * 60 * 1000), 10),
    buildTag = process.env.APP_BUILD_NUMBER ?? 'local',
  } = {}) {
    this.dockerSocket = dockerSocket
    this.deskBaseUrl = deskBaseUrl.replace(/\/$/, '')
    this.triggerToken = triggerToken
    this.statePath = path.join(dataDirectory, 'log-sentinel-state.json')
    this.containers = containers
    this.ignore = ignore
    this.matcher = matcher
    this.maxTasksPerHour = maxTasksPerHour
    this.recurCooldownMs = recurCooldownMs
    this.buildTag = buildTag
    this.state = { fingerprints: {}, created: [] }
    this.queue = Promise.resolve()
  }

  async start() {
    await mkdir(path.dirname(this.statePath), { recursive: true })
    try {
      this.state = { fingerprints: {}, created: [], ...JSON.parse(await readFile(this.statePath, 'utf8')) }
    } catch {
      this.state = { fingerprints: {}, created: [] }
    }

    for (const container of this.containers) {
      this.superviseContainer(container)
      console.log(`[sentinel] стежу за ${container.name} → проєкт ${container.project}`)
    }
  }

  superviseContainer(container) {
    const collector = new ErrorGroupCollector({
      matcher: this.matcher,
      ignore: this.ignore,
      onGroup: (lines) => {
        this.queue = this.queue
          .then(() => this.handleGroup(container, lines))
          .catch((error) => console.error(`[sentinel] ${container.name}: ${error.message}`))
      },
    })

    const connect = async () => {
      try {
        const info = await this.dockerJson(`/containers/${encodeURIComponent(container.name)}/json`)
        const tty = info?.Config?.Tty === true
        const since = Math.floor(Date.now() / 1000)
        await this.streamLogs(container, tty, since, (line) => collector.feed(line))
      } catch (error) {
        console.error(`[sentinel] ${container.name}: ${error.message}`)
      }
      setTimeout(connect, 5000).unref?.()
    }
    void connect()
  }

  dockerJson(requestPath) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { socketPath: this.dockerSocket, path: `/v1.41${requestPath}`, method: 'GET' },
        (response) => {
          let body = ''
          response.on('data', (chunk) => { body += chunk })
          response.on('end', () => {
            if ((response.statusCode ?? 500) >= 400) reject(new Error(`docker API ${response.statusCode} for ${requestPath}`))
            else resolve(JSON.parse(body || 'null'))
          })
        },
      )
      request.on('error', reject)
      request.end()
    })
  }

  streamLogs(container, tty, since, onLine) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.dockerSocket,
          path: `/v1.41/containers/${encodeURIComponent(container.name)}/logs?follow=1&stdout=1&stderr=1&since=${since}`,
          method: 'GET',
        },
        (response) => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`docker logs ${response.statusCode}`))
            return
          }
          const push = tty ? rawLineStream(onLine) : demuxDockerStream(onLine)
          response.on('data', push)
          response.on('end', resolve)
          response.on('error', reject)
        },
      )
      request.on('error', reject)
      request.end()
    })
  }

  async handleGroup(container, lines) {
    const fingerprint = fingerprintGroup(container.name, lines)
    const now = Date.now()
    const known = this.state.fingerprints[fingerprint]

    if (known) {
      known.lastSeen = now
      known.count = (known.count ?? 0) + 1
    }

    const activeTask = await this.findTaskByMarker(fingerprint)
    if (activeTask && activeTask.status !== 'done') {
      await this.saveState()
      return
    }
    if (activeTask && known && now - (known.lastCreatedAt ?? 0) < this.recurCooldownMs) {
      await this.saveState()
      return
    }

    this.state.created = (this.state.created ?? []).filter((timestamp) => now - timestamp < 60 * 60 * 1000)
    if (this.state.created.length >= this.maxTasksPerHour) {
      console.log(`[sentinel] ${container.name}: ліміт ${this.maxTasksPerHour}/год вичерпано, помилку ${fingerprint} відкладено`)
      this.state.fingerprints[fingerprint] = { ...(known ?? {}), lastSeen: now, suppressed: true }
      await this.saveState()
      return
    }

    const draft = buildTaskDraft(container, lines, fingerprint, this.buildTag)
    const task = await this.createDeskTask(draft)
    this.state.created.push(now)
    this.state.fingerprints[fingerprint] = {
      taskId: task.id,
      lastSeen: now,
      lastCreatedAt: now,
      count: (known?.count ?? 0) + 1,
    }
    await this.saveState()
    console.log(`[sentinel] ${container.name}: створено ${task.id} (${fingerprint}) — ${draft.title}`)
  }

  async findTaskByMarker(fingerprint) {
    const response = await fetch(`${this.deskBaseUrl}/api/tasks`)
    if (!response.ok) throw new Error(`desk /api/tasks → ${response.status}`)
    const tasks = await response.json()
    return tasks.find((task) => {
      const match = MARKER_PATTERN.exec(task.notes ?? '')
      return match?.[1] === fingerprint
    }) ?? null
  }

  async createDeskTask(draft) {
    const body = new FormData()
    for (const [key, value] of Object.entries(draft)) body.set(key, value)
    const response = await fetch(`${this.deskBaseUrl}/api/tasks`, {
      method: 'POST',
      headers: this.triggerToken ? { 'X-Codex-Trigger-Token': this.triggerToken } : {},
      body,
    })
    if (!response.ok) {
      const payload = await response.text()
      throw new Error(`desk create → ${response.status}: ${payload.slice(0, 200)}`)
    }
    return response.json()
  }

  async saveState() {
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf8')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sentinel = new LogSentinel()
  if (sentinel.containers.length === 0) {
    console.error('[sentinel] SENTINEL_CONTAINERS порожній — нема за чим стежити.')
    process.exit(1)
  }
  await sentinel.start()
  console.log(`[sentinel] запущено, контейнерів: ${sentinel.containers.length}, ліміт ${sentinel.maxTasksPerHour}/год`)
  setInterval(() => {}, 60_000)
}
