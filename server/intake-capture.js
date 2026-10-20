import { randomUUID } from 'node:crypto'
import { PROXY_ERROR_HEADER, evaluateDevApiPath } from './dev-api-proxy.js'

export const INTAKE_ENTITY_KINDS = ['client', 'product', 'document']
export const INTAKE_EVIDENCE_MAX_LENGTH = 30_000
export const INTAKE_COMMENT_AUTHOR = 'QA-конвеєр'
export const DEFAULT_INTAKE_PROXY_URL = 'http://dev-api-proxy:8790'

const entityLabels = {
  client: 'Клієнт',
  product: 'Товар',
  document: 'Документ (накладна продажу)',
}

const itemFields = {
  client: ['Id', 'NetUid', 'Name', 'FullName', 'USREOU', 'TIN', 'ClientNumber', 'MobileNumber', 'IsActive', 'Deleted'],
  product: ['Id', 'NetUid', 'VendorCode', 'Name', 'MainOriginalNumber', 'AvailableQtyUk', 'AvailableQtyPl', 'CurrentPrice', 'CurrentLocalPrice', 'IsForSale', 'Deleted'],
  document: ['Id', 'NetUid', 'SaleNumber.Value', 'Created', 'Deleted', 'IsLocked', 'IsInvoice', 'TotalAmount', 'TotalAmountLocal', 'TotalCount', 'ClientAgreement.Client.Name', 'ClientAgreement.Client.USREOU', 'UserFullName'],
}

const itemTitleFields = {
  client: ['Name', 'FullName'],
  product: ['VendorCode', 'Name'],
  document: ['SaleNumber.Value', 'ClientAgreement.Client.Name'],
}

function encodeQueryValue(value) {
  return encodeURIComponent(value).replace(/%2F/gi, '/')
}

export function intakeRequests(kind, code) {
  const value = encodeQueryValue(String(code ?? '').trim())
  if (!value) return []
  if (kind === 'client') {
    return [{
      label: 'Пошук клієнта за кодом, ЄДРПОУ або назвою',
      path: `/api/v1/uk/clients/registry/all/filtered?filterSql=RegionCode.Value/Client.FullName/Client.USREOU&limit=5&offset=0&value=${value}`,
    }]
  }
  if (kind === 'product') {
    return [{
      label: 'Пошук товару за артикулом',
      path: `/api/v1/uk/products/search/advanced?value=${value}&limit=5&offset=0`,
    }]
  }
  if (kind === 'document') {
    return [{
      label: 'Пошук накладної продажу за номером',
      path: `/api/v1/uk/sales/ukraine/registry?limit=5&offset=0&status=All&type=All&includeDetails=false&fastEcommerce=false&forEcommerce=false&fromShipments=false&from=2000-01-01T00:00:00&to=2100-01-01T00:00:00&value=${value}`,
    }]
  }
  return []
}

function readPath(item, dottedPath) {
  let current = item
  for (const key of dottedPath.split('.')) {
    if (!current || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

function trimValue(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 199)}…` : value
  if (typeof value === 'object') return undefined
  return value
}

function trimItem(kind, item) {
  if (!item || typeof item !== 'object') return trimValue(item)
  const trimmed = {}
  for (const field of itemFields[kind] ?? []) {
    const value = trimValue(readPath(item, field))
    if (value !== undefined) trimmed[field] = value
  }
  return trimmed
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.Body)) return payload.Body
  if (Array.isArray(payload?.Body?.Collection)) return payload.Body.Collection
  if (Array.isArray(payload?.Collection)) return payload.Collection
  return null
}

function boundEvidence(evidence) {
  if (JSON.stringify(evidence).length <= INTAKE_EVIDENCE_MAX_LENGTH) return evidence
  const reduced = {
    ...evidence,
    truncated: true,
    requests: evidence.requests.map((request) => ({ ...request, items: (request.items ?? []).slice(0, 2) })),
  }
  if (JSON.stringify(reduced).length <= INTAKE_EVIDENCE_MAX_LENGTH) return reduced
  return {
    ...evidence,
    truncated: true,
    requests: evidence.requests.map(({ items: _items, ...request }) => ({ ...request, error: request.error ? String(request.error).slice(0, 300) : undefined })),
  }
}

export async function captureIntakeEvidence(task, {
  proxyBaseUrl = DEFAULT_INTAKE_PROXY_URL,
  fetchImpl = fetch,
  timeoutMs = 45_000,
  now = () => new Date(),
} = {}) {
  const kind = String(task?.entityKind ?? '')
  const code = String(task?.entityCode ?? '').trim()
  if (!INTAKE_ENTITY_KINDS.includes(kind) || !code) return null
  const base = String(proxyBaseUrl).replace(/\/$/, '')
  const requests = []
  for (const request of intakeRequests(kind, code)) {
    const started = Date.now()
    const entry = { label: request.label, path: request.path, status: null, ok: false, itemCount: null, items: [] }
    const policy = evaluateDevApiPath(request.path)
    if (!policy.ok) {
      entry.error = `маршрут відхилено політикою проксі: ${policy.reason}`
      entry.durationMs = Date.now() - started
      requests.push(entry)
      continue
    }
    try {
      const response = await fetchImpl(`${base}${request.path}`, {
        method: 'GET',
        headers: { accept: 'application/json', 'x-time-zone': 'Europe/Kyiv' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      entry.status = response.status
      const proxyError = response.headers?.get?.(PROXY_ERROR_HEADER)
      const text = await response.text().catch(() => '')
      let payload = null
      try {
        payload = JSON.parse(text)
      } catch {
        payload = null
      }
      if (proxyError) {
        entry.proxyError = proxyError
        entry.error = String(payload?.error ?? text).slice(0, 300)
      } else if (response.ok) {
        const items = extractItems(payload)
        entry.ok = Array.isArray(items)
        entry.itemCount = Array.isArray(items) ? items.length : null
        entry.items = Array.isArray(items) ? items.slice(0, 5).map((item) => trimItem(kind, item)) : []
        if (!Array.isArray(items)) entry.error = 'відповідь DEV не містить списку'
      } else {
        entry.error = String(payload?.Message ?? payload?.message ?? text).slice(0, 300) || `HTTP ${response.status}`
      }
    } catch (error) {
      entry.error = `запит не виконано: ${String(error?.message ?? error).slice(0, 200)}`
    }
    entry.durationMs = Date.now() - started
    requests.push(entry)
  }
  return boundEvidence({
    version: 1,
    capturedAt: now().toISOString(),
    proxy: base,
    entity: { kind, code },
    requests,
  })
}

function itemTitle(kind, item) {
  return (itemTitleFields[kind] ?? [])
    .map((field) => item?.[field])
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' · ')
}

export function summarizeIntakeEvidence(evidence) {
  if (!evidence) return ''
  const label = entityLabels[evidence.entity?.kind] ?? evidence.entity?.kind
  const lines = [`[конвеєр:intake] Стан «до» на DEV зафіксовано через read-only проксі: ${label} «${evidence.entity?.code}».`]
  for (const request of evidence.requests ?? []) {
    const outcome = request.ok
      ? `${request.status}, знайдено ${request.itemCount}${request.itemCount > 0 ? `: ${(request.items ?? []).slice(0, 3).map((item) => itemTitle(evidence.entity?.kind, item) || item?.NetUid || item?.Id).filter(Boolean).join('; ')}` : ''}`
      : `${request.status ?? 'немає відповіді'} — ${request.error ?? 'помилка'}`
    lines.push(`- ${request.label}: GET ${request.path} → ${outcome}`)
  }
  if (evidence.truncated) lines.push('Частину відповіді скорочено, щоб доказ лишався компактним.')
  return lines.join('\n')
}

export function createIntakeCapture({
  store,
  proxyBaseUrl = process.env.QA_DEV_API_PROXY_URL ?? DEFAULT_INTAKE_PROXY_URL,
  fetchImpl = fetch,
  timeoutMs = 45_000,
  log = (message) => console.error(message),
} = {}) {
  return async (taskId) => {
    const task = store.find(taskId)
    if (!task) return null
    let evidence
    try {
      evidence = await captureIntakeEvidence(task, { proxyBaseUrl, fetchImpl, timeoutMs })
    } catch (error) {
      evidence = {
        version: 1,
        capturedAt: new Date().toISOString(),
        proxy: proxyBaseUrl,
        entity: { kind: task.entityKind, code: task.entityCode },
        requests: [],
        error: String(error?.message ?? error).slice(0, 300),
      }
    }
    if (!evidence) return null
    try {
      store.saveIntakeEvidence(taskId, evidence)
      store.addTaskComment(randomUUID(), taskId, {
        author: INTAKE_COMMENT_AUTHOR,
        authorUserId: null,
        parentId: null,
        body: evidence.error
          ? `[конвеєр:intake] Стан «до» на DEV не зафіксовано: ${evidence.error}`
          : summarizeIntakeEvidence(evidence).slice(0, 4900),
      })
    } catch (error) {
      log(`[intake] ${taskId}: не вдалося зберегти доказ «до»: ${error.message}`)
    }
    return evidence
  }
}
