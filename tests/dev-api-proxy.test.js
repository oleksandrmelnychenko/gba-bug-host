import assert from 'node:assert/strict'
import { createHmac, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  PROXY_ERROR_HEADER,
  PROXY_UPSTREAM_AUTH_HEADER,
  createDevApiProxy,
  createOperatorTokenProvider,
  evaluateDevApiPath,
  mintOperatorToken,
  rsaKeyId,
} from '../server/dev-api-proxy.js'

const symmetricKey = 'dev-symmetric-test-key-0123456789abcdef'
const operatorNetId = '11111111-2222-4333-8444-555555555555'

function storedOperatorToken(claims = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    NetId: operatorNetId,
    iss: 'ConcordCRM',
    aud: ['gba-api-dev'],
    nbf: 1,
    exp: 2,
    ...claims,
  })).toString('base64url')
  const signature = createHmac('sha256', symmetricKey).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}

test('proxy policy пропускає read-маршрути й відсікає GET-мутації legacy API', () => {
  for (const route of [
    '/api/v1/uk/clients/get/top',
    '/api/v1/uk/products/search/advanced?value=filter&limit=20',
    '/api/v1/uk/products/write-off/registry',
    '/api/v1/uk/accounting/pay/get',
    '/api/v1/uk/clients/sales-ukraine/create/search?value=KD02801&limit=20&offset=0',
    '/api/v1/uk/clients/sales-ukraine/edit/search?value=KD02801',
    '/api/v1/uk/sales/returns/sales-returns/create/filtered?value=1',
  ]) {
    assert.equal(evaluateDevApiPath(route).ok, true, route)
  }
  assert.deepEqual(
    evaluateDevApiPath('/analytics/api/v1/uk/constructors/sales-new-buyer-share/capabilities'),
    { ok: true, upstream: 'analytics', path: '/api/v1/uk/constructors/sales-new-buyer-share/capabilities' },
  )
  for (const route of [
    '/api/v1/uk/clients/switch/active?netId=1',
    '/api/v1/uk/clients/registry/switch/active',
    '/api/v1/uk/deliveries/recipients/remove?netId=1',
    '/api/v1/uk/deliveries/recipients/ReturnRemove',
    '/api/v1/uk/sales/shipments/update/filtered/auto',
    '/api/v1/uk/sales/shipments/warehouse-ukraine/create/auto',
    '/api/v1/uk/preorders/new',
    '/api/v1/uk/xml/documents/online-shop-seo/new',
    '/api/v1/uk/protocol/set/edit/act/for/editing',
    '/api/v1/uk/sales/shipments/update/filtered/auto',
    '/api/v1/uk/clients/remove/search',
    '/api/v1/uk/data/sync/search',
    '/api/v1/uk/data/sync/start/session',
    '/api/v1/uk/usermanagement/token',
    '/api/v1/uk/a/../b',
    '/api/v1/uk/a/%2e%2e/b',
    '/api/v1/uk/a?_method=DELETE',
    '/hubs/sync',
    '/swagger/v1/swagger.json',
  ]) {
    assert.equal(evaluateDevApiPath(route).ok, false, route)
  }
})

test('operator mint повторює dev_api.auth: перевіряє збережений токен і підписує RS256 з kid', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const minted = mintOperatorToken({
    storedToken: storedOperatorToken(),
    symmetricKey: `${symmetricKey}\n`,
    privateKeyPem,
    expectedNetId: operatorNetId,
    nowSeconds: 1_000_000,
  })
  const [header, payload, signature] = minted.token.split('.')
  const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  assert.equal(minted.algorithm, 'RS256')
  assert.equal(decodedHeader.alg, 'RS256')
  assert.equal(decodedHeader.kid, rsaKeyId(privateKey))
  assert.equal(claims.nbf, 1_000_000 - 30)
  assert.equal(claims.exp, 1_000_000 + 900)
  assert.equal(claims.NetId, operatorNetId)
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey(privateKey), Buffer.from(signature, 'base64url')), true)

  const hs = mintOperatorToken({ storedToken: storedOperatorToken(), symmetricKey, expectedNetId: operatorNetId, nowSeconds: 10 })
  assert.equal(hs.algorithm, 'HS256')

  const tampered = storedOperatorToken().replace(/.$/, (character) => (character === 'A' ? 'B' : 'A'))
  assert.throws(() => mintOperatorToken({ storedToken: tampered, symmetricKey, privateKeyPem, expectedNetId: operatorNetId }), /signature changed/)
  assert.throws(() => mintOperatorToken({ storedToken: storedOperatorToken({ NetId: 'someone-else' }), symmetricKey, privateKeyPem, expectedNetId: operatorNetId }), /scope changed/)
  assert.throws(() => mintOperatorToken({ storedToken: storedOperatorToken({ aud: ['gba-api-prod'] }), symmetricKey, privateKeyPem, expectedNetId: operatorNetId }), /scope changed/)
})

test('token provider читає secrets у runtime і кешує короткий токен', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-dev-proxy-secrets-'))
  try {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    await writeFile(path.join(root, 'operator-token.json'), JSON.stringify({ AccessToken: storedOperatorToken() }), 'utf8')
    await writeFile(path.join(root, 'jwt-key'), symmetricKey, 'utf8')
    await writeFile(path.join(root, 'jwt-private-key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), 'utf8')
    let clock = 1_000_000_000
    const provider = createOperatorTokenProvider({
      operatorTokenFile: path.join(root, 'operator-token.json'),
      symmetricKeyFile: path.join(root, 'jwt-key'),
      privateKeyFile: path.join(root, 'jwt-private-key'),
      expectedNetId: operatorNetId,
      now: () => clock,
    })
    const first = await provider()
    const second = await provider()
    assert.equal(first, second)
    clock += 15 * 60 * 1000
    assert.notEqual(await provider(), first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('proxy відмовляє в кожному не-GET методі й не торкається upstream', async () => {
  const upstreamCalls = []
  const server = createDevApiProxy({
    upstreams: { concord: 'http://upstream.invalid' },
    tokenProvider: async () => 'server-side-token',
    fetchImpl: async (...args) => {
      upstreamCalls.push(args)
      return new Response('{}')
    },
    log: () => {},
  })
  const base = await listen(server)
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await fetch(`${base}/api/v1/uk/clients/get/top`, { method, body: ['POST', 'PUT', 'PATCH'].includes(method) ? '{}' : undefined })
      assert.equal(response.status, 405, method)
      assert.equal(response.headers.get(PROXY_ERROR_HEADER), 'method')
    }
    const policy = await fetch(`${base}/api/v1/uk/clients/switch/active?netId=1`)
    assert.equal(policy.status, 403)
    assert.equal(policy.headers.get(PROXY_ERROR_HEADER), 'policy')
    assert.equal(upstreamCalls.length, 0)
  } finally {
    server.close()
  }
})

test('proxy підставляє серверний credential, не пропускає клієнтські заголовки й маркує upstream 401', async () => {
  const seen = []
  const server = createDevApiProxy({
    upstreams: { concord: 'http://concord.test', analytics: 'http://analytics.test' },
    tokenProvider: async () => 'server-side-token',
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      if (url.includes('/expired')) return new Response('{"message":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ Body: [{ NetUid: 'a' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'session=leak' },
      })
    },
    log: () => {},
  })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/api/v1/uk/clients/get/top?limit=5`, {
      headers: { authorization: 'Bearer agent-supplied', cookie: 'x=1', 'x-http-method-override': 'DELETE', 'x-time-zone': 'Europe/Kyiv' },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { Body: [{ NetUid: 'a' }] })
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal(seen[0].url, 'http://concord.test/api/v1/uk/clients/get/top?limit=5')
    assert.equal(seen[0].init.method, 'GET')
    assert.equal(seen[0].init.headers.authorization, 'Bearer server-side-token')
    assert.equal(seen[0].init.headers.cookie, undefined)
    assert.equal(seen[0].init.headers['x-http-method-override'], undefined)
    assert.equal(seen[0].init.headers['x-time-zone'], 'Europe/Kyiv')

    await fetch(`${base}/analytics/api/v1/uk/reports/catalogue`)
    assert.equal(seen[1].url, 'http://analytics.test/api/v1/uk/reports/catalogue')

    const expired = await fetch(`${base}/api/v1/uk/clients/get/expired`)
    assert.equal(expired.status, 401)
    assert.equal(expired.headers.get(PROXY_UPSTREAM_AUTH_HEADER), 'rejected')
  } finally {
    server.close()
  }
})

test('proxy healthz повідомляє про недоступний credential без витоку секретів', async () => {
  const server = createDevApiProxy({
    upstreams: { concord: 'http://concord.test' },
    tokenProvider: async () => {
      throw new Error('DEV operator signature changed')
    },
    log: () => {},
  })
  const base = await listen(server)
  try {
    const health = await fetch(`${base}/healthz`)
    assert.equal(health.status, 503)
    assert.equal(health.headers.get(PROXY_ERROR_HEADER), 'credential')
    const request = await fetch(`${base}/api/v1/uk/clients/get/top`)
    assert.equal(request.status, 503)
    assert.equal(request.headers.get(PROXY_ERROR_HEADER), 'credential')
  } finally {
    server.close()
  }
})

test('повільний DEV endpoint дає 504 з маркером timeout, а не мовчазне зависання', async () => {
  const server = createDevApiProxy({
    upstreams: { concord: 'http://concord.test' },
    tokenProvider: async () => 'server-side-token',
    timeoutMs: 20,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    }),
    log: () => {},
  })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/api/v1/uk/clients/get/top`)
    assert.equal(response.status, 504)
    assert.equal(response.headers.get(PROXY_ERROR_HEADER), 'upstream-timeout')
  } finally {
    server.close()
  }
})
