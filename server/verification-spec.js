import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PROXY_ERROR_HEADER, PROXY_UPSTREAM_AUTH_HEADER, evaluateDevApiPath } from './dev-api-proxy.js'

export const VERIFY_SPEC_DIRECTORY = '.qa-desk/verify'
export const DEFAULT_DEV_API_PROXY_URL = 'http://dev-api-proxy:8790'
export const DEV_PUBLIC_HOSTS = new Set([
  'gba-console-dev.85.17.167.167.nip.io',
  'shop-dev.85.17.167.167.nip.io',
  'gba-api-dev.85.17.167.167.nip.io',
  'gba-analytics-dev.85.17.167.167.nip.io',
  'ecom-api-dev.85.17.167.167.nip.io',
])
export const VERIFY_OPERATORS = [
  'exists', 'absent', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'matches', 'in',
  'count_eq', 'count_gte', 'count_lte', 'count_gt', 'count_lt', 'body_contains', 'body_not_contains',
]

const MAX_CHECKS = 20
const MAX_ASSERTIONS = 40
const VALUE_OPERATORS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'matches', 'in'])
const COUNT_OPERATORS = new Set(['count_eq', 'count_gte', 'count_lte', 'count_gt', 'count_lt'])
const BODY_OPERATORS = new Set(['body_contains', 'body_not_contains'])
const PLACEHOLDER_UUID = /00000000-0000-0000-0000-000000000000/i

export function verificationSpecPath(directory, taskId) {
  return path.join(directory, VERIFY_SPEC_DIRECTORY, `${taskId}.json`)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseJsonPath(expression) {
  const value = String(expression ?? '').trim()
  if (value !== '$' && !value.startsWith('$.') && !value.startsWith('$[')) return null
  const tokens = []
  let rest = value.slice(1)
  while (rest.length > 0) {
    if (rest.startsWith('.')) {
      const match = /^\.([^.[\]]+)/.exec(rest)
      if (!match) return null
      tokens.push({ type: 'key', key: match[1] })
      rest = rest.slice(match[0].length)
      continue
    }
    const index = /^\[(\*|\d+)\]/.exec(rest)
    if (index) {
      tokens.push(index[1] === '*' ? { type: 'wildcard' } : { type: 'index', index: Number(index[1]) })
      rest = rest.slice(index[0].length)
      continue
    }
    const quoted = /^\[(?:'([^']*)'|"([^"]*)")\]/.exec(rest)
    if (quoted) {
      tokens.push({ type: 'key', key: quoted[1] ?? quoted[2] })
      rest = rest.slice(quoted[0].length)
      continue
    }
    return null
  }
  return tokens
}

function readKey(value, key) {
  if (!isPlainObject(value)) return { found: false }
  if (Object.hasOwn(value, key)) return { found: true, value: value[key] }
  const lower = key.toLowerCase()
  const match = Object.keys(value).find((candidate) => candidate.toLowerCase() === lower)
  return match === undefined ? { found: false } : { found: true, value: value[match] }
}

export function resolveJsonPath(document, expression) {
  const tokens = parseJsonPath(expression)
  if (!tokens) throw new Error(`невалідний JSON path «${expression}»`)
  let current = [document]
  for (const token of tokens) {
    const next = []
    for (const value of current) {
      if (token.type === 'key') {
        const read = readKey(value, token.key)
        if (read.found) next.push(read.value)
      } else if (token.type === 'index') {
        if (Array.isArray(value) && token.index < value.length) next.push(value[token.index])
      } else if (Array.isArray(value)) {
        next.push(...value)
      } else if (isPlainObject(value)) {
        next.push(...Object.values(value))
      }
    }
    current = next
  }
  return { values: current, wildcard: tokens.some((token) => token.type === 'wildcard') }
}

function deepEqual(left, right) {
  if (left === right) return true
  if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object') return false
  return JSON.stringify(left) === JSON.stringify(right)
}

function preview(value, maximum = 200) {
  let text
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  text = String(text ?? 'undefined')
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text
}

function compare(op, actual, expected) {
  switch (op) {
    case 'eq': return deepEqual(actual, expected)
    case 'ne': return !deepEqual(actual, expected)
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const left = typeof actual === 'number' ? actual : Number(actual)
      const right = Number(expected)
      if (!Number.isFinite(left) || !Number.isFinite(right) || actual === null || actual === '' || typeof actual === 'boolean') return false
      if (op === 'gt') return left > right
      if (op === 'gte') return left >= right
      if (op === 'lt') return left < right
      return left <= right
    }
    case 'contains':
    case 'not_contains': {
      let found
      if (Array.isArray(actual)) found = actual.some((item) => deepEqual(item, expected))
      else if (typeof actual === 'string') found = actual.toLocaleLowerCase().includes(String(expected).toLocaleLowerCase())
      else found = false
      return op === 'contains' ? found : !found && (Array.isArray(actual) || typeof actual === 'string')
    }
    case 'matches': {
      if (actual === null || actual === undefined || typeof actual === 'object') return false
      return new RegExp(String(expected), 'iu').test(String(actual))
    }
    case 'in': return Array.isArray(expected) && expected.some((item) => deepEqual(item, actual))
    default: return false
  }
}

export function evaluateAssertion(assertion, { json, jsonError = '', body = '' }) {
  const op = assertion.op
  const base = { op, path: assertion.path ?? null, expected: assertion.value ?? null }
  if (BODY_OPERATORS.has(op)) {
    const found = String(body).toLocaleLowerCase().includes(String(assertion.value).toLocaleLowerCase())
    const passed = op === 'body_contains' ? found : !found
    return { ...base, passed, actual: passed ? (op === 'body_contains' ? 'знайдено' : 'відсутній') : (found ? 'знайдено' : 'не знайдено') }
  }
  if (json === undefined) {
    return { ...base, passed: false, actual: `тіло не є JSON${jsonError ? `: ${jsonError}` : ''}` }
  }
  let resolved
  try {
    resolved = resolveJsonPath(json, assertion.path)
  } catch (error) {
    return { ...base, passed: false, actual: error.message }
  }
  const { values, wildcard } = resolved
  if (op === 'exists') {
    const present = values.filter((value) => value !== null && value !== undefined)
    return { ...base, passed: present.length > 0, actual: present.length > 0 ? `${present.length} знач.: ${preview(present.slice(0, 3))}` : 'відсутнє або null' }
  }
  if (op === 'absent') {
    const present = values.filter((value) => value !== null && value !== undefined)
    return { ...base, passed: present.length === 0, actual: present.length === 0 ? 'відсутнє' : preview(present.slice(0, 3)) }
  }
  if (COUNT_OPERATORS.has(op)) {
    let count
    if (wildcard) count = values.length
    else if (values.length === 1 && Array.isArray(values[0])) count = values[0].length
    else if (values.length === 1 && isPlainObject(values[0])) count = Object.keys(values[0]).length
    else if (values.length === 0) count = 0
    else return { ...base, passed: false, actual: `не масив: ${preview(values[0])}` }
    const expected = Number(assertion.value)
    const passed = op === 'count_eq' ? count === expected
      : op === 'count_gte' ? count >= expected
        : op === 'count_lte' ? count <= expected
          : op === 'count_gt' ? count > expected
            : count < expected
    return { ...base, passed, actual: `count=${count}` }
  }
  if (values.length === 0) return { ...base, passed: false, actual: 'шлях не знайдено у відповіді' }
  const quantifier = assertion.quantifier === 'any' ? 'any' : 'all'
  let results
  try {
    results = values.map((value) => compare(op, value, assertion.value))
  } catch (error) {
    return { ...base, passed: false, actual: error.message }
  }
  const passed = quantifier === 'any' ? results.some(Boolean) : results.every(Boolean)
  const failing = values.filter((_value, index) => !results[index])
  return {
    ...base,
    quantifier,
    passed,
    actual: passed
      ? `${values.length} знач.: ${preview(values.slice(0, 3))}`
      : `${failing.length}/${values.length} не відповідають: ${preview(failing.slice(0, 3))}`,
  }
}

function validateAssertion(assertion, label, index) {
  const where = `${label}: assertion #${index + 1}`
  if (!isPlainObject(assertion)) return `${where} має бути об’єктом`
  if (!VERIFY_OPERATORS.includes(assertion.op)) return `${where}: невідомий op «${assertion.op}»`
  if (BODY_OPERATORS.has(assertion.op)) {
    if (typeof assertion.value !== 'string' || !assertion.value.trim() || assertion.value.length > 500) {
      return `${where}: ${assertion.op} потребує непорожній рядок value до 500 символів`
    }
    return ''
  }
  if (typeof assertion.path !== 'string' || assertion.path.length > 300 || !parseJsonPath(assertion.path)) {
    return `${where}: path має бути JSON path на кшталт $.Body[*].NetUid`
  }
  if (COUNT_OPERATORS.has(assertion.op)) {
    if (!Number.isInteger(assertion.value) || assertion.value < 0) return `${where}: ${assertion.op} потребує невід’ємне ціле value`
  } else if (VALUE_OPERATORS.has(assertion.op)) {
    if (!Object.hasOwn(assertion, 'value')) return `${where}: ${assertion.op} потребує value`
    if (assertion.op === 'in' && !Array.isArray(assertion.value)) return `${where}: in потребує масив value`
    if (['gt', 'gte', 'lt', 'lte'].includes(assertion.op) && !Number.isFinite(Number(assertion.value))) return `${where}: ${assertion.op} потребує число`
    if (assertion.op === 'matches') {
      if (typeof assertion.value !== 'string' || assertion.value.length > 200) return `${where}: matches потребує regex-рядок до 200 символів`
      try {
        new RegExp(assertion.value, 'iu')
      } catch (error) {
        return `${where}: невалідний regex: ${error.message}`
      }
    }
    if (preview(assertion.value, 2000).length > 1000) return `${where}: value завелике`
  }
  if (assertion.quantifier !== undefined && !['all', 'any'].includes(assertion.quantifier)) return `${where}: quantifier має бути all або any`
  return ''
}

export function validateVerificationSpec(spec, { taskId = '' } = {}) {
  const errors = []
  if (!isPlainObject(spec)) return { ok: false, errors: ['spec має бути JSON-об’єктом'] }
  if (taskId && spec.task !== taskId) errors.push(`spec.task має дорівнювати ${taskId}`)
  if (typeof spec.scenario !== 'string' || spec.scenario.trim().length < 10 || spec.scenario.length > 2000) {
    errors.push('spec.scenario має коротко описувати live-сценарій баг-репорту (10–2000 символів)')
  }
  if (!Array.isArray(spec.checks) || spec.checks.length === 0) errors.push('spec.checks має містити щонайменше одну GET-перевірку')
  else if (spec.checks.length > MAX_CHECKS) errors.push(`spec.checks: максимум ${MAX_CHECKS}`)
  const checks = Array.isArray(spec.checks) ? spec.checks.slice(0, MAX_CHECKS) : []
  checks.forEach((check, index) => {
    const label = isPlainObject(check) && typeof check.label === 'string' && check.label.trim() ? check.label.trim() : `check #${index + 1}`
    if (!isPlainObject(check)) {
      errors.push(`${label} має бути об’єктом`)
      return
    }
    if (typeof check.label !== 'string' || !check.label.trim() || check.label.length > 200) errors.push(`${label}: потрібен label до 200 символів`)
    if (check.method !== undefined && String(check.method).toUpperCase() !== 'GET') errors.push(`${label}: дозволений лише GET`)
    if (!['concord', 'analytics', 'public'].includes(check.api)) errors.push(`${label}: api має бути concord, analytics або public`)
    if (check.api === 'concord' || check.api === 'analytics') {
      if (typeof check.path !== 'string' || !check.path.startsWith('/api/')) {
        errors.push(`${label}: path має починатися з /api/`)
      } else {
        const policy = evaluateDevApiPath(check.api === 'analytics' ? `/analytics${check.path}` : check.path)
        if (!policy.ok) errors.push(`${label}: ${policy.reason}`)
        if (PLACEHOLDER_UUID.test(check.path)) errors.push(`${label}: placeholder UUID заборонений`)
      }
    }
    if (check.api === 'public') {
      let url
      try {
        url = new URL(check.url)
      } catch {
        errors.push(`${label}: public-перевірка потребує повний url`)
      }
      if (url) {
        if (url.protocol !== 'https:' || url.username || url.password) errors.push(`${label}: дозволений лише https URL без credentials`)
        if (!DEV_PUBLIC_HOSTS.has(url.hostname)) errors.push(`${label}: host ${url.hostname} не є DEV vhost (${[...DEV_PUBLIC_HOSTS].join(', ')})`)
        if (PLACEHOLDER_UUID.test(url.href)) errors.push(`${label}: placeholder UUID заборонений`)
      }
    }
    if (!Number.isInteger(check.expectStatus) || check.expectStatus < 100 || check.expectStatus > 599) errors.push(`${label}: потрібен цілий expectStatus`)
    const assertions = Array.isArray(check.assertions) ? check.assertions : []
    if (check.assertions !== undefined && !Array.isArray(check.assertions)) errors.push(`${label}: assertions має бути масивом`)
    if (assertions.length > MAX_ASSERTIONS) errors.push(`${label}: максимум ${MAX_ASSERTIONS} assertions`)
    if (Number.isInteger(check.expectStatus) && check.expectStatus >= 200 && check.expectStatus < 300 && assertions.length === 0) {
      errors.push(`${label}: успішна відповідь потребує хоча б одну assertion на кількості/поля/текст`)
    }
    assertions.slice(0, MAX_ASSERTIONS).forEach((assertion, assertionIndex) => {
      const error = validateAssertion(assertion, label, assertionIndex)
      if (error) errors.push(error)
    })
  })
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    errors: [],
    spec: {
      task: spec.task,
      scenario: spec.scenario.trim(),
      checks: checks.map((check) => ({
        label: check.label.trim(),
        api: check.api,
        ...(check.api === 'public' ? { url: check.url } : { path: check.path }),
        expectStatus: check.expectStatus,
        assertions: (check.assertions ?? []).map((assertion) => ({
          op: assertion.op,
          ...(assertion.path !== undefined ? { path: assertion.path } : {}),
          ...(Object.hasOwn(assertion, 'value') ? { value: assertion.value } : {}),
          ...(assertion.quantifier ? { quantifier: assertion.quantifier } : {}),
        })),
      })),
    },
  }
}

export async function readVerificationSpecFile(filePath, { taskId = '' } = {}) {
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false, ok: false, errors: [`spec ${filePath} не знайдено`] }
    return { present: false, ok: false, errors: [`spec ${filePath} не читається: ${error.message}`] }
  }
  if (raw.length > 200_000) return { present: true, ok: false, errors: ['spec більший за 200 KB'] }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { present: true, ok: false, errors: [`spec не є валідним JSON: ${error.message}`] }
  }
  const validation = validateVerificationSpec(parsed, { taskId })
  return { present: true, ...validation }
}

function checkRequestUrl(check, proxyBaseUrl) {
  if (check.api === 'public') return check.url
  const base = String(proxyBaseUrl ?? '').replace(/\/$/, '')
  return `${base}${check.api === 'analytics' ? '/analytics' : ''}${check.path}`
}

export async function runVerificationSpec(spec, {
  proxyBaseUrl = process.env.QA_DEV_API_PROXY_URL ?? DEFAULT_DEV_API_PROXY_URL,
  fetchImpl = fetch,
  timeoutMs = 200_000,
} = {}) {
  const startedAt = new Date().toISOString()
  const checks = []
  let infrastructure = false
  for (const check of spec.checks) {
    const started = Date.now()
    const requestUrl = checkRequestUrl(check, proxyBaseUrl)
    const entry = {
      label: check.label,
      api: check.api,
      request: check.api === 'public' ? check.url : check.path,
      expectStatus: check.expectStatus,
      actualStatus: null,
      passed: false,
      assertions: [],
    }
    let response
    try {
      response = await fetchImpl(requestUrl, {
        method: 'GET',
        headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.5', 'x-time-zone': 'Europe/Kyiv' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      entry.error = `запит не виконано: ${String(error?.message ?? error).slice(0, 300)}`
      entry.infrastructure = true
      infrastructure = true
      entry.durationMs = Date.now() - started
      checks.push(entry)
      continue
    }
    const body = await response.text().catch(() => '')
    entry.actualStatus = response.status
    const proxyError = response.headers.get(PROXY_ERROR_HEADER)
    if (proxyError) {
      entry.proxyError = proxyError
      entry.error = `DEV API proxy: ${preview(body, 300)}`
      if (!['policy', 'method'].includes(proxyError)) {
        entry.infrastructure = true
        infrastructure = true
      }
    } else if (response.headers.get(PROXY_UPSTREAM_AUTH_HEADER) === 'rejected') {
      entry.error = 'DEV API відхилив службовий operator credential (401)'
      entry.infrastructure = true
      infrastructure = true
    }
    let json
    let jsonError = ''
    const trimmed = body.trimStart()
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || /json/i.test(response.headers.get('content-type') ?? '')) {
      try {
        json = JSON.parse(body)
      } catch (error) {
        jsonError = error.message
      }
    }
    const statusPassed = response.status === check.expectStatus
    entry.assertions = check.assertions.map((assertion) => evaluateAssertion(assertion, { json, jsonError, body }))
    entry.passed = statusPassed && !entry.error && entry.assertions.every((assertion) => assertion.passed)
    if (!statusPassed) entry.statusMismatch = true
    if (response.status >= 500) entry.serverError = true
    entry.durationMs = Date.now() - started
    checks.push(entry)
  }
  const passed = checks.length > 0 && checks.every((check) => check.passed)
  return {
    passed,
    infrastructure: !passed && infrastructure,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
  }
}

export function compactVerificationResult(result, maximumLength = 40_000) {
  if (!result) return result
  const compact = {
    ...result,
    checks: (result.checks ?? []).map((check) => ({
      ...check,
      assertions: (check.assertions ?? []).map((assertion) => ({
        ...assertion,
        actual: preview(assertion.actual, 300),
        expected: assertion.expected === null || assertion.expected === undefined ? null : preview(assertion.expected, 300),
      })),
    })),
  }
  if (JSON.stringify(compact).length <= maximumLength) return compact
  compact.checks = compact.checks.map((check) => ({
    ...check,
    assertions: check.assertions.filter((assertion) => !assertion.passed).slice(0, 10),
    assertionsTrimmed: true,
  }))
  if (JSON.stringify(compact).length <= maximumLength) return compact
  return {
    passed: result.passed,
    infrastructure: result.infrastructure,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    checks: compact.checks.map((check) => ({ label: check.label, request: preview(check.request, 300), expectStatus: check.expectStatus, actualStatus: check.actualStatus, passed: check.passed })),
    truncated: true,
  }
}

export function formatVerificationReport(result, { maximumLength = 3000 } = {}) {
  if (!result) return 'live-перевірка не виконувалась'
  const lines = []
  const total = result.checks?.length ?? 0
  const passedCount = (result.checks ?? []).filter((check) => check.passed).length
  lines.push(`${result.passed ? 'PASS' : 'FAIL'}: ${passedCount}/${total} GET-перевірок`)
  for (const check of result.checks ?? []) {
    lines.push(`${check.passed ? '✓' : '✗'} ${check.label} — GET ${check.request} → ${check.actualStatus ?? 'немає відповіді'} (очікувано ${check.expectStatus})${check.error ? `; ${check.error}` : ''}`)
    for (const assertion of check.assertions ?? []) {
      if (check.passed && assertion.passed && lines.length > 12) continue
      lines.push(`   ${assertion.passed ? '✓' : '✗'} ${assertion.op}${assertion.path ? ` ${assertion.path}` : ''}${assertion.expected !== null && assertion.expected !== undefined ? ` ${preview(assertion.expected, 80)}` : ''} → ${preview(assertion.actual, 160)}`)
    }
  }
  const text = lines.join('\n')
  return text.length > maximumLength ? `${text.slice(0, maximumLength - 1)}…` : text
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const specFile = args.find((arg) => !arg.startsWith('--'))
  const baseIndex = args.indexOf('--base')
  const proxyBaseUrl = baseIndex >= 0 ? args[baseIndex + 1] : (process.env.QA_DEV_API_PROXY_URL ?? DEFAULT_DEV_API_PROXY_URL)
  const taskIndex = args.indexOf('--task')
  const taskId = taskIndex >= 0 ? args[taskIndex + 1] : path.basename(specFile ?? '', '.json')
  if (!specFile) {
    console.error('Використання: node server/verification-spec.js <spec.json> [--base http://dev-api-proxy:8790] [--task BUG-XXXX] [--json]')
    process.exit(2)
  }
  const read = await readVerificationSpecFile(path.resolve(specFile), { taskId })
  if (!read.ok) {
    console.error(`INVALID SPEC:\n- ${read.errors.join('\n- ')}`)
    process.exit(2)
  }
  const result = await runVerificationSpec(read.spec, { proxyBaseUrl })
  console.log(formatVerificationReport(result, { maximumLength: 20_000 }))
  if (args.includes('--json')) console.log(JSON.stringify(compactVerificationResult(result), null, 2))
  process.exit(result.passed ? 0 : result.infrastructure ? 2 : 1)
}
