import { createHash, createHmac, createPrivateKey, createPublicKey, sign as signPayload, timingSafeEqual } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export const PROXY_ERROR_HEADER = 'x-dev-api-proxy-error'
export const PROXY_UPSTREAM_AUTH_HEADER = 'x-dev-api-proxy-upstream-auth'

export const DENIED_ROUTE_WORDS = new Set([
  'new', 'add', 'create', 'insert', 'upsert', 'update', 'edit', 'change', 'set', 'save', 'write',
  'remove', 'delete', 'del', 'erase', 'purge', 'clear', 'reset', 'drop', 'truncate',
  'switch', 'toggle', 'enable', 'disable', 'activate', 'deactivate',
  'lock', 'unlock', 'block', 'unblock', 'cancel', 'approve', 'reject', 'decline', 'confirm', 'accept',
  'apply', 'assign', 'unassign', 'attach', 'detach', 'bind', 'unbind', 'link', 'unlink',
  'merge', 'split', 'move', 'transfer', 'copy', 'clone', 'convert', 'reserve', 'unreserve',
  'import', 'upload', 'sync', 'synchronize', 'start', 'stop', 'run', 'execute', 'process', 'trigger',
  'generate', 'recalculate', 'recalc', 'rebuild', 'refresh', 'reindex', 'restore', 'revert', 'rollback', 'commit',
  'publish', 'unpublish', 'send', 'resend', 'notify', 'push', 'mark', 'close', 'reopen', 'archive', 'unarchive',
  'auto', 'seed', 'migrate', 'migration', 'init', 'initialize', 'repair', 'retry',
  'login', 'logout', 'signin', 'signout', 'token', 'tokens', 'auth', 'authorize', 'password', 'impersonate',
  'hubs', 'hub', 'negotiate', 'signalr', 'maintenance', 'cutover', 'outbox',
])

const ALLOWED_COMPOUND_SEGMENTS = new Set(['write-off', 'write-offs'])
const PICKER_SEARCH_TERMINALS = new Set(['search', 'filtered'])
const PICKER_CONTEXT_VERBS = new Set(['create', 'edit', 'new', 'add', 'update'])

const DENIED_QUERY_KEYS = new Set(['_method', 'x-http-method-override', 'x-method-override', 'method'])
const ALLOWED_TIME_ZONE = /^[A-Za-z_]+(?:\/[A-Za-z_+-]+){0,2}$/

function camelWords(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean)
}

export function routeWords(segment) {
  const value = String(segment ?? '')
  if (ALLOWED_COMPOUND_SEGMENTS.has(value.toLowerCase())) return []
  if (value.includes('-')) return camelWords(value.split('-').find(Boolean) ?? '')
  return camelWords(value)
}

export function evaluateDevApiPath(rawTarget) {
  const target = String(rawTarget ?? '')
  if (!target.startsWith('/')) return { ok: false, reason: 'шлях має починатися з /' }
  if (target.length > 4000) return { ok: false, reason: 'шлях задовгий' }
  if (/[\\\u0000-\u001f]|%(?:2e|2f|5c|00)/i.test(target)) return { ok: false, reason: 'заборонені символи або закодовані розділювачі у шляху' }
  const queryIndex = target.indexOf('?')
  const rawPath = queryIndex >= 0 ? target.slice(0, queryIndex) : target
  const rawQuery = queryIndex >= 0 ? target.slice(queryIndex + 1) : ''
  if (rawPath.includes('//')) return { ok: false, reason: 'порожній сегмент шляху' }

  let upstream
  let upstreamPath
  if (rawPath.startsWith('/analytics/api/')) {
    upstream = 'analytics'
    upstreamPath = rawPath.slice('/analytics'.length)
  } else if (rawPath.startsWith('/api/')) {
    upstream = 'concord'
    upstreamPath = rawPath
  } else {
    return { ok: false, reason: 'дозволені лише /api/... (data-concord) або /analytics/api/... (data-analytics)' }
  }

  const segments = upstreamPath.split('/').filter(Boolean)
  let lastSegment = ''
  try {
    lastSegment = decodeURIComponent(segments.at(-1) ?? '').toLowerCase()
  } catch {
    lastSegment = ''
  }
  const pickerSearch = PICKER_SEARCH_TERMINALS.has(lastSegment)
  for (const rawSegment of segments) {
    let segment
    try {
      segment = decodeURIComponent(rawSegment)
    } catch {
      return { ok: false, reason: `некоректне кодування сегмента «${rawSegment}»` }
    }
    if (segment === '.' || segment === '..') return { ok: false, reason: 'відносні сегменти заборонені' }
    const denied = routeWords(segment).find((word) => DENIED_ROUTE_WORDS.has(word) && !(pickerSearch && PICKER_CONTEXT_VERBS.has(word)))
    if (denied) {
      return {
        ok: false,
        reason: `маршрут містить «${denied}» — він схожий на мутацію або службову дію, тому проксі його не пропускає навіть як GET`,
      }
    }
  }

  if (rawQuery) {
    for (const pair of rawQuery.split('&')) {
      const key = pair.split('=')[0]
      let decodedKey
      try {
        decodedKey = decodeURIComponent(key.replace(/\+/g, ' ')).trim().toLowerCase()
      } catch {
        return { ok: false, reason: 'некоректне кодування query' }
      }
      if (DENIED_QUERY_KEYS.has(decodedKey)) return { ok: false, reason: `query-параметр «${decodedKey}» заборонений` }
    }
  }

  return {
    ok: true,
    upstream,
    path: `${upstreamPath}${rawQuery ? `?${rawQuery}` : ''}`,
  }
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url')
}

function audienceIncludes(audience, expected) {
  if (Array.isArray(audience)) return audience.some((item) => String(item).includes(expected))
  return String(audience ?? '').includes(expected)
}

async function fileExists(filePath) {
  if (!filePath) return false
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export function rsaKeyId(privateKey) {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' })
  return base64Url(createHash('sha256').update(`{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`).digest())
}

export function mintOperatorToken({
  storedToken,
  symmetricKey,
  privateKeyPem = '',
  expectedNetId,
  issuer = 'ConcordCRM',
  audience = 'gba-api-dev',
  algorithm = '',
  lifetimeSeconds = 900,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const parts = String(storedToken ?? '').trim().split('.')
  if (parts.length !== 3) throw new Error('збережений DEV operator token має невалідний формат')
  const [header, payload, signature] = parts
  const key = Buffer.from(String(symmetricKey ?? '').trim())
  if (key.length === 0) throw new Error('DEV symmetric key порожній')
  const expected = Buffer.from(createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url'))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('DEV operator signature changed')
  }
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  if (!expectedNetId || claims.NetId !== expectedNetId || claims.iss !== issuer || !audienceIncludes(claims.aud, audience)) {
    throw new Error('DEV operator scope changed')
  }
  claims.nbf = nowSeconds - 30
  claims.exp = nowSeconds + lifetimeSeconds
  const encodedClaims = base64Url(JSON.stringify(claims))
  const selected = (algorithm || (privateKeyPem ? 'RS256' : 'HS256')).toUpperCase()
  if (selected === 'RS256') {
    if (!privateKeyPem) throw new Error('RS256 потребує DEV private key')
    const privateKey = createPrivateKey(privateKeyPem)
    const encodedHeader = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: rsaKeyId(privateKey) }))
    const signed = signPayload('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedClaims}`), privateKey).toString('base64url')
    return { token: `${encodedHeader}.${encodedClaims}.${signed}`, expiresAt: claims.exp * 1000, algorithm: 'RS256' }
  }
  if (selected !== 'HS256') throw new Error(`непідтримуваний алгоритм ${selected}`)
  const signed = createHmac('sha256', key).update(`${header}.${encodedClaims}`).digest('base64url')
  return { token: `${header}.${encodedClaims}.${signed}`, expiresAt: claims.exp * 1000, algorithm: 'HS256' }
}

export function createOperatorTokenProvider({
  operatorTokenFile,
  symmetricKeyFile,
  privateKeyFile = '',
  expectedNetId,
  issuer,
  audience,
  algorithm = '',
  lifetimeSeconds = 900,
  refreshMarginMs = 120_000,
  now = () => Date.now(),
}) {
  let cached = null
  return async () => {
    if (cached && cached.expiresAt - refreshMarginMs > now()) return cached.token
    const stored = JSON.parse(await readFile(operatorTokenFile, 'utf8'))
    const storedToken = stored?.AccessToken ?? stored?.accessToken
    const symmetricKey = await readFile(symmetricKeyFile, 'utf8')
    const privateKeyPem = await fileExists(privateKeyFile) ? await readFile(privateKeyFile, 'utf8') : ''
    cached = mintOperatorToken({
      storedToken,
      symmetricKey,
      privateKeyPem,
      expectedNetId,
      issuer,
      audience,
      algorithm,
      lifetimeSeconds,
      nowSeconds: Math.floor(now() / 1000),
    })
    return cached.token
  }
}

function sendJson(response, status, payload, errorKind = '') {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-dev-api-proxy': 'read-only',
    ...(errorKind ? { [PROXY_ERROR_HEADER]: errorKind } : {}),
  })
  response.end(body)
}

async function readLimitedBody(upstreamResponse, maxBytes) {
  if (!upstreamResponse.body) return { buffer: Buffer.alloc(0), truncated: false }
  const reader = upstreamResponse.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return { buffer: null, truncated: true }
    }
    chunks.push(Buffer.from(value))
  }
  return { buffer: Buffer.concat(chunks), truncated: false }
}

export function createDevApiProxy({
  upstreams,
  tokenProvider,
  fetchImpl = fetch,
  timeoutMs = 180_000,
  maxBodyBytes = 25 * 1024 * 1024,
  maxConcurrent = 6,
  log = (entry) => console.log(JSON.stringify(entry)),
} = {}) {
  let inFlight = 0
  return createServer(async (request, response) => {
    const startedAt = Date.now()
    const method = request.method ?? 'GET'
    const target = request.url ?? '/'
    const finish = (status, extra = {}) => log({ at: new Date().toISOString(), method, target: target.slice(0, 500), status, ms: Date.now() - startedAt, ...extra })

    if (target === '/healthz' && method === 'GET') {
      try {
        await tokenProvider()
        sendJson(response, 200, { ok: true, credential: 'ready', upstreams: Object.keys(upstreams) })
        finish(200)
      } catch (error) {
        sendJson(response, 503, { ok: false, credential: 'unavailable', error: String(error?.message ?? error).slice(0, 200) }, 'credential')
        finish(503, { error: 'credential' })
      }
      return
    }

    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(response, 405, { error: `DEV API proxy пропускає лише GET/HEAD; ${method} відхилено` }, 'method')
      finish(405, { refused: 'method' })
      return
    }

    const policy = evaluateDevApiPath(target)
    if (!policy.ok) {
      sendJson(response, 403, { error: `DEV API proxy відхилив маршрут: ${policy.reason}` }, 'policy')
      finish(403, { refused: 'policy', reason: policy.reason })
      return
    }

    const upstreamBase = upstreams[policy.upstream]
    if (!upstreamBase) {
      sendJson(response, 404, { error: `upstream ${policy.upstream} не налаштовано` }, 'policy')
      finish(404, { refused: 'upstream' })
      return
    }

    if (inFlight >= maxConcurrent) {
      sendJson(response, 429, { error: 'DEV API proxy зайнятий; повтори запит за кілька секунд' }, 'busy')
      finish(429, { refused: 'busy' })
      return
    }

    inFlight += 1
    try {
      let token
      try {
        token = await tokenProvider()
      } catch (error) {
        sendJson(response, 503, { error: `DEV operator credential недоступний: ${String(error?.message ?? error).slice(0, 200)}` }, 'credential')
        finish(503, { error: 'credential' })
        return
      }

      const headers = {
        authorization: `Bearer ${token}`,
        accept: typeof request.headers.accept === 'string' ? request.headers.accept.slice(0, 200) : 'application/json',
      }
      const language = request.headers['accept-language']
      if (typeof language === 'string' && language.length <= 100) headers['accept-language'] = language
      const timeZone = request.headers['x-time-zone']
      if (typeof timeZone === 'string' && ALLOWED_TIME_ZONE.test(timeZone)) headers['x-time-zone'] = timeZone

      let upstreamResponse
      try {
        upstreamResponse = await fetchImpl(`${upstreamBase.replace(/\/$/, '')}${policy.path}`, {
          method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || /timeout/i.test(String(error?.message ?? ''))
        sendJson(response, timedOut ? 504 : 502, {
          error: timedOut
            ? `DEV ${policy.upstream} не відповів за ${Math.round(timeoutMs / 1000)} с`
            : `DEV ${policy.upstream} недоступний: ${String(error?.message ?? error).slice(0, 200)}`,
        }, timedOut ? 'upstream-timeout' : 'upstream')
        finish(timedOut ? 504 : 502, { error: timedOut ? 'upstream-timeout' : 'upstream' })
        return
      }

      const { buffer, truncated } = method === 'HEAD'
        ? { buffer: Buffer.alloc(0), truncated: false }
        : await readLimitedBody(upstreamResponse, maxBodyBytes)
      if (truncated) {
        sendJson(response, 502, { error: `відповідь DEV більша за ${maxBodyBytes} байт` }, 'too-large')
        finish(502, { error: 'too-large' })
        return
      }

      const responseHeaders = {
        'cache-control': 'no-store',
        'x-dev-api-proxy': 'read-only',
        'content-length': buffer.length,
      }
      const contentType = upstreamResponse.headers.get('content-type')
      if (contentType) responseHeaders['content-type'] = contentType
      const disposition = upstreamResponse.headers.get('content-disposition')
      if (disposition) responseHeaders['content-disposition'] = disposition
      const location = upstreamResponse.headers.get('location')
      if (location && upstreamResponse.status >= 300 && upstreamResponse.status < 400) responseHeaders.location = location
      if (upstreamResponse.status === 401) responseHeaders[PROXY_UPSTREAM_AUTH_HEADER] = 'rejected'
      response.writeHead(upstreamResponse.status, responseHeaders)
      response.end(buffer)
      finish(upstreamResponse.status, { upstream: policy.upstream, bytes: buffer.length })
    } catch (error) {
      if (!response.headersSent) sendJson(response, 502, { error: String(error?.message ?? error).slice(0, 200) }, 'upstream')
      else response.destroy()
      finish(502, { error: 'internal' })
    } finally {
      inFlight -= 1
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const required = (name) => {
    const value = process.env[name]
    if (!value) throw new Error(`${name} не задано`)
    return value
  }
  const tokenProvider = createOperatorTokenProvider({
    operatorTokenFile: required('DEV_API_OPERATOR_TOKEN_FILE'),
    symmetricKeyFile: required('DEV_API_JWT_KEY_FILE'),
    privateKeyFile: process.env.DEV_API_JWT_PRIVATE_KEY_FILE ?? '',
    expectedNetId: required('DEV_API_OPERATOR_NET_ID'),
    issuer: process.env.DEV_API_JWT_ISSUER ?? 'ConcordCRM',
    audience: process.env.DEV_API_JWT_AUDIENCE ?? 'gba-api-dev',
    algorithm: process.env.DEV_API_JWT_ALG ?? '',
  })
  const upstreams = {
    concord: process.env.DEV_API_CONCORD_UPSTREAM ?? 'http://gba-dev-data-concord-1:35981',
    analytics: process.env.DEV_API_ANALYTICS_UPSTREAM ?? 'http://gba-dev-data-analytics-1:35982',
  }
  for (const [name, value] of Object.entries(upstreams)) {
    if (/prod/i.test(value)) throw new Error(`upstream ${name} вказує на prod: ${value}`)
  }
  const server = createDevApiProxy({
    upstreams,
    tokenProvider,
    timeoutMs: Number.parseInt(process.env.DEV_API_PROXY_TIMEOUT_MS ?? '180000', 10),
  })
  const port = Number.parseInt(process.env.DEV_API_PROXY_PORT ?? '8790', 10)
  server.listen(port, '0.0.0.0', () => {
    console.log(`[dev-api-proxy] GET-only DEV API proxy слухає :${port} → ${Object.entries(upstreams).map(([name, value]) => `${name}=${value}`).join(', ')}`)
  })
  const shutdown = () => server.close(() => process.exit(0))
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}
