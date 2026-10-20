export const LONG_RUN_MS = 45 * 60 * 1000
export const STALE_TASK_MS = 60 * 60 * 1000
export const USAGE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000
export const USAGE_LIMIT_PATTERN = /usage limit|rate limit|\b429\b/i

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running'])
const PENDING_RELEASE_STATUSES = new Set(['pending', 'processing', 'retrying', 'waiting_mainline'])
const FINISHED_RUN_STATUSES = new Set(['completed', 'needs_review', 'blocked', 'failed'])
const STOPPED_PATTERN = /Зупинено оператором|Знято з черги|Знято оператором|вимкнено AI/i
const MARKER_PATTERNS = [
  ['released', /\[released:([^\]]+)\]/g],
  ['release_blocked', /\[release-blocked:([^\]]+)\]/g],
  ['waiting_mainline', /\[release-waiting-mainline:([0-9a-f]{7,40})\]/g],
  ['live_verify_failed', /\[live-verify-failed:([^\]]+)\]/g],
  ['release_recovered', /\[release-recovered:([^\]]+)\]/g],
]
const PIPELINE_COMMENT_PATTERN = /^\[конвеєр:([a-z_-]+)\]/

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function time(value) {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function span(from, to) {
  const start = time(from)
  const end = time(to)
  return start !== null && end !== null && end >= start ? end - start : null
}

export function percentile(values, rank) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1))
  return sorted[index]
}

export function distribution(values) {
  const finite = values.filter((value) => Number.isFinite(value))
  return { count: finite.length, p50: percentile(finite, 50), p90: percentile(finite, 90) }
}

export function weekStart(timestamp) {
  const date = new Date(timestamp)
  const day = (date.getUTCDay() + 6) % 7
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day)).toISOString().slice(0, 10)
}

function maxTime(values) {
  const times = values.map(time).filter((value) => value !== null)
  return times.length > 0 ? new Date(Math.max(...times)).toISOString() : null
}

export function normalizeRun(row) {
  const details = parseObject(row.details)
  const evidence = parseObject(row.release_evidence ?? row.releaseEvidence)
  return {
    id: row.id,
    taskId: row.task_id ?? row.taskId,
    trigger: row.trigger ?? 'manual',
    triggerReason: row.trigger_reason ?? row.triggerReason ?? '',
    status: row.status,
    attempt: row.attempt ?? 1,
    error: row.error ?? '',
    details,
    releaseStatus: row.release_status ?? row.releaseStatus ?? '',
    releasePhase: row.release_phase ?? row.releasePhase ?? '',
    releaseError: row.release_error ?? row.releaseError ?? '',
    evidence,
    releasedAt: row.released_at ?? row.releasedAt ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    startedAt: row.started_at ?? row.startedAt ?? null,
    finishedAt: row.finished_at ?? row.finishedAt ?? null,
    heartbeatAt: row.heartbeat_at ?? row.heartbeatAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
  }
}

export function classifyRunOutcome(run) {
  if (run.releaseStatus === 'released') return 'released'
  if (ACTIVE_RUN_STATUSES.has(run.status)) return run.status
  if (run.releaseStatus === 'waiting_mainline') return 'waiting_mainline'
  if (STOPPED_PATTERN.test(`${run.error}\n${run.releaseError}`)) return 'stopped'
  if (run.status === 'failed') return USAGE_LIMIT_PATTERN.test(run.error) ? 'codex_usage_limit' : 'codex_failed'
  if (run.status === 'needs_review' || run.status === 'blocked') {
    const gate = run.details.qualityGate
    if (gate?.applied && gate.passed === false) return 'quality_gate'
    return 'needs_review'
  }
  if (run.evidence.liveVerification?.passed === false || /live-перевірка/i.test(run.releaseError)) return 'live_verification_failed'
  if (run.releaseStatus === 'blocked') {
    if ((run.evidence.mainlineHold || /червоний і на чистому|mainline/i.test(run.releaseError)) && !run.evidence.failure?.mainlineGate) return 'mainline_red'
    const phase = run.evidence.failure?.phase || run.releasePhase || 'release'
    return `release_blocked:${phase === 'failed' ? 'release' : phase}`
  }
  if (PENDING_RELEASE_STATUSES.has(run.releaseStatus)) return 'in_release'
  return run.status || 'unknown'
}

export function parseMarkerEvents(notes) {
  const events = []
  for (const [kind, pattern] of MARKER_PATTERNS) {
    for (const match of String(notes ?? '').matchAll(pattern)) {
      const raw = match[1].trim()
      if (kind === 'waiting_mainline') {
        events.push({ kind, at: null, detail: raw.slice(0, 12) })
        continue
      }
      const at = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw) ? `${raw.replace(' ', 'T')}:00.000Z` : raw
      events.push({ kind, at: time(at) !== null ? new Date(time(at)).toISOString() : null, detail: '' })
    }
  }
  return events
}

export function pipelineCommentEvents(comments) {
  return comments
    .map((comment) => {
      const match = PIPELINE_COMMENT_PATTERN.exec(String(comment.body ?? '').trim())
      return match ? { kind: `comment:${match[1]}`, at: comment.created_at ?? comment.createdAt ?? null, detail: '' } : null
    })
    .filter(Boolean)
}

function runTimeline(run) {
  const repositories = Object.values(run.evidence.repositories ?? {})
  const live = run.evidence.liveVerification
  return {
    queuedAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    gatesAt: maxTime(repositories.map((repository) => repository?.validatedAt)),
    publishedAt: maxTime(repositories.map((repository) => repository?.pushedAt)),
    deployedAt: run.evidence.deployment?.verifiedAt ?? null,
    verifiedAt: live?.passed === true ? live.at ?? null : null,
    releasedAt: run.releasedAt,
    waitingMainlineSince: run.evidence.mainlineHold?.since ?? null,
  }
}

export function computeMetrics({ tasks = [], runs = [], lastComments = [], pipelineComments = [], now = Date.now(), days = 28 } = {}) {
  const since = now - days * 24 * 60 * 60 * 1000
  const normalizedRuns = runs.map(normalizeRun)
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  const runsByTask = new Map()
  for (const run of normalizedRuns) {
    const bucket = runsByTask.get(run.taskId) ?? []
    bucket.push(run)
    runsByTask.set(run.taskId, bucket)
  }
  for (const bucket of runsByTask.values()) bucket.sort((left, right) => (time(right.createdAt) ?? 0) - (time(left.createdAt) ?? 0))

  const finished = normalizedRuns.filter((run) => {
    const finishedAt = time(run.finishedAt)
    const task = tasksById.get(run.taskId)
    return FINISHED_RUN_STATUSES.has(run.status)
      && finishedAt !== null
      && finishedAt >= since
      && task?.ai_mode !== 'off'
      && !STOPPED_PATTERN.test(`${run.error}\n${run.releaseError}`)
  })
  const released = finished.filter((run) => run.releaseStatus === 'released')
  const inWindow = normalizedRuns.filter((run) => (time(run.createdAt) ?? 0) >= since)

  const totals = {
    finishedRuns: finished.length,
    releasedRuns: released.length,
    releaseRate: finished.length > 0 ? released.length / finished.length : null,
    timeToDeploy: distribution(released.map((run) => span(run.finishedAt, run.releasedAt))),
    codexDuration: distribution(inWindow.map((run) => span(run.startedAt, run.finishedAt))),
    queueWait: distribution(inWindow.map((run) => span(run.createdAt, run.startedAt))),
  }

  const weeks = new Map()
  for (const run of finished) {
    const key = weekStart(time(run.finishedAt))
    const bucket = weeks.get(key) ?? { weekStart: key, finished: [], released: [] }
    bucket.finished.push(run)
    if (run.releaseStatus === 'released') bucket.released.push(run)
    weeks.set(key, bucket)
  }
  const weekly = [...weeks.values()]
    .sort((left, right) => left.weekStart.localeCompare(right.weekStart))
    .map((bucket) => {
      const deploy = distribution(bucket.released.map((run) => span(run.finishedAt, run.releasedAt)))
      return {
        weekStart: bucket.weekStart,
        finishedRuns: bucket.finished.length,
        releasedRuns: bucket.released.length,
        releaseRate: bucket.finished.length > 0 ? bucket.released.length / bucket.finished.length : null,
        timeToDeployP50: deploy.p50,
        timeToDeployP90: deploy.p90,
      }
    })

  const reasons = new Map()
  for (const run of normalizedRuns) {
    const finishedAt = time(run.finishedAt) ?? time(run.updatedAt)
    if (finishedAt === null || finishedAt < since || ACTIVE_RUN_STATUSES.has(run.status)) continue
    const outcome = classifyRunOutcome(run)
    if (outcome === 'released' || outcome === 'in_release') continue
    const entry = reasons.get(outcome) ?? { reason: outcome, count: 0, taskIds: [] }
    entry.count += 1
    if (!entry.taskIds.includes(run.taskId) && entry.taskIds.length < 10) entry.taskIds.push(run.taskId)
    reasons.set(outcome, entry)
  }
  const failureReasons = [...reasons.values()].sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))

  const lastCommentAt = new Map(lastComments.map((row) => [row.task_id ?? row.taskId, row.last_comment_at ?? row.lastCommentAt]))
  const commentsByTask = new Map()
  for (const comment of pipelineComments) {
    const taskId = comment.task_id ?? comment.taskId
    const bucket = commentsByTask.get(taskId) ?? []
    bucket.push(comment)
    commentsByTask.set(taskId, bucket)
  }

  const alerts = []
  for (const task of tasks) {
    if (task.status === 'done') continue
    if (/^MAIN RED/i.test(task.title ?? '') || String(task.notes ?? '').includes('[main-red:')) {
      alerts.push({ kind: 'main_red', taskId: task.id, title: task.title, since: task.created_at ?? task.createdAt ?? null })
    }
  }
  const holds = new Map()
  for (const run of normalizedRuns) {
    const latest = runsByTask.get(run.taskId)?.[0]
    if (latest?.id !== run.id || run.releaseStatus !== 'waiting_mainline') continue
    if (tasksById.get(run.taskId)?.status === 'done') continue
    const hold = run.evidence.mainlineHold ?? {}
    const key = `${hold.repo ?? 'repo'}@${hold.sha ?? ''}`
    const entry = holds.get(key) ?? { kind: 'main_red', source: 'release-hold', repo: hold.repo ?? '', sha: hold.sha ?? '', check: Array.isArray(hold.check) ? hold.check.join(' ') : hold.check ?? '', since: hold.since ?? null, taskIds: [] }
    entry.taskIds.push(run.taskId)
    holds.set(key, entry)
  }
  alerts.push(...holds.values())

  for (const run of normalizedRuns) {
    if (run.status !== 'running') continue
    const started = time(run.startedAt)
    if (started !== null && now - started > LONG_RUN_MS) {
      alerts.push({ kind: 'long_run', taskId: run.taskId, runId: run.id, minutes: Math.round((now - started) / 60_000) })
    }
  }

  const usageFailures = normalizedRuns.filter((run) => {
    const at = time(run.finishedAt) ?? time(run.updatedAt)
    return run.status === 'failed' && at !== null && now - at <= USAGE_LIMIT_WINDOW_MS && USAGE_LIMIT_PATTERN.test(run.error)
  })
  if (usageFailures.length > 0) {
    alerts.push({
      kind: 'usage_limit',
      count: usageFailures.length,
      lastAt: maxTime(usageFailures.map((run) => run.finishedAt ?? run.updatedAt)),
      taskIds: [...new Set(usageFailures.map((run) => run.taskId))].slice(0, 10),
    })
  }

  for (const task of tasks) {
    if (task.status === 'done') continue
    const latest = runsByTask.get(task.id)?.[0]
    if (!latest) continue
    const busy = ACTIVE_RUN_STATUSES.has(latest.status)
      || (PENDING_RELEASE_STATUSES.has(latest.releaseStatus) && ['completed', 'needs_review'].includes(latest.status))
    if (!busy) continue
    const lastTouch = Math.max(time(task.updated_at ?? task.updatedAt) ?? 0, time(lastCommentAt.get(task.id)) ?? 0)
    if (lastTouch > 0 && now - lastTouch > STALE_TASK_MS) {
      alerts.push({ kind: 'stale_task', taskId: task.id, title: task.title, minutes: Math.round((now - lastTouch) / 60_000), runStatus: latest.status, releaseStatus: latest.releaseStatus })
    }
  }

  const timeline = [...runsByTask.entries()]
    .map(([taskId, taskRuns]) => ({ taskId, latest: taskRuns[0], taskRuns }))
    .filter(({ latest }) => (time(latest.createdAt) ?? 0) >= since || ACTIVE_RUN_STATUSES.has(latest.status) || PENDING_RELEASE_STATUSES.has(latest.releaseStatus))
    .sort((left, right) => (time(right.latest.createdAt) ?? 0) - (time(left.latest.createdAt) ?? 0))
    .slice(0, 50)
    .map(({ taskId, latest, taskRuns }) => {
      const task = tasksById.get(taskId) ?? {}
      const stages = runTimeline(latest)
      const events = [
        ...parseMarkerEvents(task.notes),
        ...pipelineCommentEvents(commentsByTask.get(taskId) ?? []),
      ].filter((event) => event.at === null || (time(event.at) ?? 0) >= (time(latest.createdAt) ?? 0))
        .sort((left, right) => (time(left.at) ?? Number.POSITIVE_INFINITY) - (time(right.at) ?? Number.POSITIVE_INFINITY))
      return {
        taskId,
        title: task.title ?? '',
        project: task.project ?? 'console',
        taskStatus: task.status ?? '',
        runId: latest.id,
        attempt: latest.attempt,
        trigger: latest.triggerReason || latest.trigger,
        runStatus: latest.status,
        releaseStatus: latest.releaseStatus,
        releasePhase: latest.releasePhase,
        outcome: classifyRunOutcome(latest),
        runsInWindow: taskRuns.filter((run) => (time(run.createdAt) ?? 0) >= since).length,
        stages,
        durations: {
          queueWaitMs: span(stages.queuedAt, stages.startedAt),
          codexMs: span(stages.startedAt, stages.finishedAt),
          deployMs: span(stages.finishedAt, stages.releasedAt),
        },
        events: events.slice(-12),
      }
    })

  return {
    generatedAt: new Date(now).toISOString(),
    days,
    since: new Date(since).toISOString(),
    totals,
    weekly,
    failureReasons,
    alerts,
    timeline,
  }
}
