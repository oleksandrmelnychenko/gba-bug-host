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

