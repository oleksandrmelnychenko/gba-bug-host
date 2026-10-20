const SECRET_PATTERNS = [
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/gi, '[REDACTED_API_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, 'Bearer [REDACTED]'],
  [/\b(Password|Pwd|Secret|ApiKey|Token)\s*=\s*[^;\s]+/gi, '$1=[REDACTED]'],
]

function redactSecrets(value) {
  let result = String(value ?? '')
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement)
  return result
}

function compactText(value, maximum) {
  const normalized = redactSecrets(value).replace(/\r\n/g, '\n').trim()
  if (normalized.length <= maximum) return normalized
  return `${normalized.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`
}

function changedFiles(details) {
  try {
    const parsed = JSON.parse(details || '{}')
    if (!Array.isArray(parsed.changedFiles)) return []
    return parsed.changedFiles
      .filter((item) => typeof item === 'string')
      .slice(0, 12)
      .map((item) => compactText(item, 180))
  } catch {
    return []
  }
}

export function composePersistentContext({
  project,
  baseContext,
  releasedRuns = [],
  generatedAt = new Date().toISOString(),
  maximumLength = 30_000,
}) {
  const base = compactText(baseContext, Math.max(1_000, Math.floor(maximumLength * 0.55)))
  const sections = [
    `Версійований постійний контекст GBA\nПроєкт: ${project}\nЗнімок сформовано: ${generatedAt}`,
    base || 'Базовий контекст не налаштовано.',
  ]

  if (releasedRuns.length > 0) {
    const history = releasedRuns.map((run) => {
      const files = changedFiles(run.details)
      return [
        `- ${run.taskId} · ${compactText(run.title, 160)} · ${run.releasedAt || 'release date unavailable'}`,
        `  ${compactText(run.summary, 700) || 'Виправлення випущено без текстового summary.'}`,
        ...(files.length ? [`  Змінені файли: ${files.join(', ')}`] : []),
      ].join('\n')
    }).join('\n')
    sections.push(`Останні підтверджені release-и цього проєкту:\n${history}`)
  }

  const combined = sections.join('\n\n').trim()
  return combined.length <= maximumLength
    ? combined
    : `${combined.slice(0, Math.max(0, maximumLength - 1)).trimEnd()}…`
}

export function codexSessionIdFromEventLine(line) {
  try {
    const event = JSON.parse(line)
    if (!['thread.started', 'session_meta'].includes(event?.type)) return ''
    const candidates = [
      event.thread_id,
      event.threadId,
      event.session_id,
      event.sessionId,
      event.payload?.thread_id,
      event.payload?.threadId,
      event.payload?.session_id,
      event.payload?.sessionId,
      event.payload?.id,
    ]
    return candidates.find((value) => typeof value === 'string' && value.trim())?.trim() ?? ''
  } catch {
    return ''
  }
}

export function createCodexSessionTracker(onSession) {
  let buffer = ''
  let sessionId = ''

  return {
    consume(chunk) {
      if (sessionId) return sessionId
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        sessionId = codexSessionIdFromEventLine(line)
        if (!sessionId) continue
        onSession?.(sessionId)
        break
      }
      return sessionId
    },
    finish() {
      if (!sessionId && buffer.trim()) {
        sessionId = codexSessionIdFromEventLine(buffer)
        if (sessionId) onSession?.(sessionId)
      }
      return sessionId
    },
    get sessionId() {
      return sessionId
    },
  }
}


export const CODEX_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000
export const CODEX_SESSION_MAX_MAINLINE_DRIFT = 20
export const PIPELINE_COMMENT_PATTERN = /^\[конвеєр:[a-z_-]+\]/

export function isPipelineComment(comment) {
  return PIPELINE_COMMENT_PATTERN.test(String(comment?.body ?? '').trim())
}

function runFinishedAt(run) {
  return Date.parse(run?.finishedAt ?? run?.updatedAt ?? run?.createdAt ?? '')
}

export function decideCodexSession({
  run,
  previousRun = null,
  model = '',
  mainlineDrift = null,
  now = Date.now(),
  maxAgeMs = CODEX_SESSION_MAX_AGE_MS,
  maxDrift = CODEX_SESSION_MAX_MAINLINE_DRIFT,
}) {
  const fresh = (reason) => ({ mode: 'fresh', reason, sessionId: '' })
  if (run?.sessionMode) {
    return run.codexSessionId
      ? { mode: 'resume', reason: 'interrupted-run', sessionId: run.codexSessionId }
      : fresh('interrupted-run-without-session')
  }
  if (!previousRun) return fresh('first-run')
  if (run?.trigger !== 'review_again') return fresh(`trigger:${run?.trigger || 'unknown'}`)
  if (previousRun.status !== 'completed') return fresh(`previous-verdict:${previousRun.status || 'unknown'}`)
  if (previousRun.releaseStatus === 'blocked' || previousRun.releasePhase === 'failed') return fresh('previous-release-failed')
  if (!previousRun.sessionMode) return fresh('previous-run-legacy')
  const finishedAt = runFinishedAt(previousRun)
  if (Number.isNaN(finishedAt) || now - finishedAt > maxAgeMs) return fresh(`previous-run-older-than-${Math.round(maxAgeMs / 3_600_000)}h`)
  if ((previousRun.codexModel ?? '') !== (model ?? '')) {
    return fresh(`model-changed:${previousRun.codexModel || 'default'}->${model || 'default'}`)
  }
  if (mainlineDrift === null || mainlineDrift === undefined || !Number.isFinite(mainlineDrift)) return fresh('mainline-drift-unknown')
  if (mainlineDrift > maxDrift) return fresh(`mainline-moved:${mainlineDrift}-commits`)
  if (!previousRun.codexSessionId) return fresh('previous-session-missing')
  return { mode: 'resume', reason: 'quick-follow-up', sessionId: previousRun.codexSessionId }
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function runCommitLines(run) {
  const evidence = parseObject(run.releaseEvidence)
  const published = Object.entries(evidence.repositories ?? {})
    .filter(([, value]) => value?.commit)
    .map(([repo, value]) => `${repo}@${String(value.commit).slice(0, 12)} (у ${value.branch ?? 'main'})`)
  if (published.length > 0) return published.join(', ')
  const heads = Object.entries(parseObject(run.headCommits))
    .map(([repo, value]) => `${repo}@${String(value?.commit ?? value).slice(0, 12)}${value?.dirty ? ' + незакомічені зміни' : ''}`)
  return heads.length > 0 ? heads.join(', ') : 'не зафіксовано'
}

export function composePriorRunsContext({ runs = [], comments = [], maximumLength = 6_000, maximumRuns = 5 } = {}) {
  const ordered = [...runs]
    .sort((left, right) => Date.parse(right.createdAt ?? 0) - Date.parse(left.createdAt ?? 0))
    .slice(0, maximumRuns)
  if (ordered.length === 0) return ''
  const chronological = [...ordered].reverse()
  const sections = chronological.map((run, index) => {
    const details = parseObject(run.details)
    const evidence = parseObject(run.releaseEvidence)
    const nextRun = chronological[index + 1]
    const from = runFinishedAt(run)
    const until = nextRun ? Date.parse(nextRun.createdAt ?? '') : Number.POSITIVE_INFINITY
    const later = comments.filter((comment) => {
      const created = Date.parse(comment.createdAt ?? '')
      return !Number.isNaN(created) && created >= from && created < until
    })
    const files = Array.isArray(details.changedFiles) ? details.changedFiles.slice(0, 10) : []
    const verdict = [run.status, details.outcome].filter(Boolean).join('/')
    const live = evidence.liveVerification
    const lines = [
      `- Спроба #${run.attempt ?? '?'} (${run.trigger || 'manual'}, ${run.createdAt ?? 'дата невідома'}) · вердикт: ${verdict || 'невідомо'} · сесія: ${run.sessionMode || 'legacy'}${run.sessionReason ? ` (${run.sessionReason})` : ''}`,
      run.reviewComment ? `  Запит QA до спроби: ${compactText(run.reviewComment, 300)}` : '',
      `  Підсумок: ${compactText(run.summary || run.error, 500) || 'немає'}`,
      details.rootCause ? `  Root cause: ${compactText(details.rootCause, 300)}` : '',
      details.blocker ? `  Блокер: ${compactText(details.blocker, 300)}` : '',
      files.length > 0 ? `  Змінені файли: ${files.map((file) => compactText(file, 120)).join(', ')}` : '',
      `  Гілка: ${run.branch || 'немає'} · коміти: ${runCommitLines(run)}`,
      `  Release: ${run.releaseStatus || 'немає'}${run.releasePhase ? `/${run.releasePhase}` : ''}${run.releaseError ? ` — ${compactText(run.releaseError, 300)}` : ''}`,
      live ? `  Live-перевірка DEV: ${live.passed ? 'PASS' : live.skipped ? 'пропущено' : 'FAIL'}${live.report ? ` — ${compactText(live.report, 300)}` : ''}` : '',
      later.length > 0
        ? `  Коментарі після спроби: ${later.map((comment) => `[${comment.id}] ${compactText(comment.author, 40)}: ${compactText(comment.body, 200)}`).join(' | ')}`
        : '',
    ].filter(Boolean)
    return lines.join('\n')
  })
  let block = sections.join('\n')
  while (block.length > maximumLength && sections.length > 1) {
    sections.shift()
    block = `- (старіші спроби пропущено)\n${sections.join('\n')}`
  }
  return block.length > maximumLength ? `${block.slice(0, maximumLength - 1)}…` : block
}
