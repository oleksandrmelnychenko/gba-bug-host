import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PROXY_ERROR_HEADER, PROXY_UPSTREAM_AUTH_HEADER } from '../server/dev-api-proxy.js'
import {
  compactVerificationResult,
  evaluateAssertion,
  formatVerificationReport,
  readVerificationSpecFile,
  resolveJsonPath,
  runVerificationSpec,
  validateVerificationSpec,
  verificationSpecPath,
} from '../server/verification-spec.js'

const validSpec = {
  task: 'BUG-1389',
  scenario: 'Пошук клієнта в продажі повертає реальних клієнтів, а не синтетичну папку',
  checks: [{
    label: 'пошук клієнта',
    api: 'concord',
    path: '/api/v1/uk/clients/get/search?value=%D0%A2%D0%9E%D0%92',
    expectStatus: 200,
    assertions: [
      { path: '$.Body', op: 'count_gte', value: 1 },
      { path: '$.Body[*].IsFolder', op: 'eq', value: false },
    ],
  }],
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } })
}

test('spec валідатор пропускає лише GET через проксі або DEV vhost із реальними assertions', () => {
  const valid = validateVerificationSpec(validSpec, { taskId: 'BUG-1389' })
  assert.equal(valid.ok, true, valid.errors.join('; '))
  assert.equal(valid.spec.checks[0].assertions.length, 2)

  const cases = [
    [{ ...validSpec, task: 'BUG-1' }, /spec.task/],
    [{ ...validSpec, checks: [{ ...validSpec.checks[0], method: 'POST' }] }, /лише GET/],
    [{ ...validSpec, checks: [{ ...validSpec.checks[0], path: '/api/v1/uk/clients/switch/active?netId=1' }] }, /switch/],
    [{ ...validSpec, checks: [{ ...validSpec.checks[0], path: '/api/v1/uk/clients/get?netId=00000000-0000-0000-0000-000000000000' }] }, /placeholder/],
    [{ ...validSpec, checks: [{ ...validSpec.checks[0], assertions: [] }] }, /assertion/],
    [{ ...validSpec, checks: [{ ...validSpec.checks[0], assertions: [{ path: '$.Body', op: 'equals', value: 1 }] }] }, /невідомий op/],
    [{ ...validSpec, checks: [{ label: 'prod', api: 'public', url: 'https://gba-console.85.17.167.167.nip.io/', expectStatus: 200, assertions: [{ op: 'body_contains', value: 'GBA' }] }] }, /не є DEV vhost/],
    [{ ...validSpec, checks: [{ label: 'http', api: 'public', url: 'http://shop-dev.85.17.167.167.nip.io/', expectStatus: 200, assertions: [{ op: 'body_contains', value: 'GBA' }] }] }, /https/],
    [{ ...validSpec, scenario: '' }, /scenario/],
    [{ ...validSpec, checks: [] }, /щонайменше одну/],
  ]
  for (const [spec, pattern] of cases) {
    const result = validateVerificationSpec(spec, { taskId: 'BUG-1389' })
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), pattern)
  }
  assert.equal(validateVerificationSpec({
    ...validSpec,
    checks: [{ label: 'shop', api: 'public', url: 'https://shop-dev.85.17.167.167.nip.io/catalog', expectStatus: 200, assertions: [{ op: 'body_contains', value: 'Каталог' }] }],
  }, { taskId: 'BUG-1389' }).ok, true)
})

test('assertions покривають статус-незалежні поля, кількості, wildcard all/any і текст', () => {
  const json = {
    Body: [
      { NetUid: 'a', Name: 'ТОВ Альфа', IsFolder: false, Total: 10 },
      { NetUid: 'b', Name: 'ФОП Бета', IsFolder: false, Total: 2 },
    ],
    Meta: { total: 2 },
  }
  const body = JSON.stringify(json)
  const check = (assertion) => evaluateAssertion(assertion, { json, body })
  assert.equal(check({ path: '$.Body', op: 'count_eq', value: 2 }).passed, true)
  assert.equal(check({ path: '$.Body[*].NetUid', op: 'count_gte', value: 2 }).passed, true)
  assert.equal(check({ path: '$.Body[*].IsFolder', op: 'eq', value: false }).passed, true)
  assert.equal(check({ path: '$.Body[*].Total', op: 'gte', value: 5 }).passed, false)
  assert.equal(check({ path: '$.Body[*].Total', op: 'gte', value: 5, quantifier: 'any' }).passed, true)
  assert.equal(check({ path: '$.body[0].name', op: 'contains', value: 'альфа' }).passed, true)
  assert.equal(check({ path: '$.Body[1].Name', op: 'matches', value: '^ФОП' }).passed, true)
  assert.equal(check({ path: '$.Meta.total', op: 'in', value: [1, 2] }).passed, true)
  assert.equal(check({ path: '$.Body[*].NetUid', op: 'ne', value: '00000000-0000-0000-0000-000000000000' }).passed, true)
  assert.equal(check({ path: '$.Missing', op: 'absent' }).passed, true)
  assert.equal(check({ path: '$.Missing', op: 'exists' }).passed, false)
  assert.equal(check({ path: '$.Missing', op: 'eq', value: 1 }).passed, false)
  assert.equal(check({ op: 'body_contains', value: 'ФОП БЕТА' }).passed, true)
  assert.equal(check({ op: 'body_not_contains', value: 'папка' }).passed, true)
  assert.equal(evaluateAssertion({ path: '$.Body', op: 'exists' }, { json: undefined, body: '<html>' }).passed, false)
  assert.deepEqual(resolveJsonPath(json, "$['Meta'].total").values, [2])
})

test('runner відрізняє падіння сценарію від інфраструктури проксі', async () => {
  const passing = await runVerificationSpec(validSpec, {
    proxyBaseUrl: 'http://proxy.test',
    fetchImpl: async (url) => {
      assert.equal(url, `http://proxy.test${validSpec.checks[0].path}`)
      return jsonResponse({ Body: [{ IsFolder: false }] })
    },
  })
  assert.equal(passing.passed, true)

  const failing = await runVerificationSpec(validSpec, {
    proxyBaseUrl: 'http://proxy.test',
    fetchImpl: async () => jsonResponse({ Body: [{ IsFolder: true, NetUid: 'folder' }] }),
  })
  assert.equal(failing.passed, false)
  assert.equal(failing.infrastructure, false)
  assert.match(formatVerificationReport(failing), /FAIL: 0\/1/)

  const refused = await runVerificationSpec(validSpec, {
    proxyBaseUrl: 'http://proxy.test',
    fetchImpl: async () => jsonResponse({ error: 'policy' }, { status: 403, headers: { [PROXY_ERROR_HEADER]: 'policy' } }),
  })
  assert.equal(refused.passed, false)
  assert.equal(refused.infrastructure, false)

  const unreachable = await runVerificationSpec(validSpec, {
    proxyBaseUrl: 'http://proxy.test',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  assert.equal(unreachable.infrastructure, true)

  const rejected = await runVerificationSpec(validSpec, {
    proxyBaseUrl: 'http://proxy.test',
    fetchImpl: async () => jsonResponse({}, { status: 401, headers: { [PROXY_UPSTREAM_AUTH_HEADER]: 'rejected' } }),
  })
  assert.equal(rejected.infrastructure, true)

  const analytics = await runVerificationSpec({
    ...validSpec,
    checks: [{ ...validSpec.checks[0], api: 'analytics', path: '/api/v1/uk/reports/catalogue', assertions: [{ path: '$', op: 'exists' }] }],
  }, {
    proxyBaseUrl: 'http://proxy.test/',
    fetchImpl: async (url) => {
      assert.equal(url, 'http://proxy.test/analytics/api/v1/uk/reports/catalogue')
      return jsonResponse({ ok: true })
    },
  })
  assert.equal(analytics.passed, true)
})

test('компактний результат вміщується в release evidence', () => {
  const huge = {
    passed: false,
    infrastructure: false,
    checks: Array.from({ length: 20 }, (_, index) => ({
      label: `check ${index}`,
      request: `/api/v1/uk/x/${index}`,
      expectStatus: 200,
      actualStatus: 200,
      passed: false,
      assertions: Array.from({ length: 40 }, () => ({ op: 'eq', path: '$.A', expected: 'x'.repeat(5000), actual: 'y'.repeat(5000), passed: false })),
    })),
  }
  assert.ok(JSON.stringify(compactVerificationResult(huge, 20_000)).length <= 20_000)
})

test('CLI повертає exit 0/1/2 для PASS, FAIL та невалідного spec', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-verify-cli-'))
  let folder = false
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ Body: [{ IsFolder: folder }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const run = async (specFile) => {
    const child = spawn(process.execPath, ['server/verification-spec.js', specFile, '--base', base], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const [code] = await once(child, 'close')
    return { code, output }
  }
  try {
    const specFile = verificationSpecPath(root, 'BUG-1389')
    await mkdir(path.dirname(specFile), { recursive: true })
    await writeFile(specFile, JSON.stringify(validSpec), 'utf8')
    assert.equal((await readVerificationSpecFile(specFile, { taskId: 'BUG-1389' })).ok, true)

    const pass = await run(specFile)
    assert.equal(pass.code, 0, pass.output)
    assert.match(pass.output, /PASS: 1\/1/)

    folder = true
    const fail = await run(specFile)
    assert.equal(fail.code, 1, fail.output)

    await writeFile(specFile, JSON.stringify({ ...validSpec, checks: [{ ...validSpec.checks[0], path: '/api/v1/uk/preorders/new' }] }), 'utf8')
    const invalid = await run(specFile)
    assert.equal(invalid.code, 2, invalid.output)
    assert.match(invalid.output, /INVALID SPEC/)
  } finally {
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})
