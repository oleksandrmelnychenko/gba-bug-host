import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import request from 'supertest'
import { createApp } from '../server/app.js'
import { isPipelineComment } from '../server/codex-context.js'
import { PROXY_ERROR_HEADER, evaluateDevApiPath } from '../server/dev-api-proxy.js'
import {
  INTAKE_EVIDENCE_MAX_LENGTH,
  captureIntakeEvidence,
  createIntakeCapture,
  intakeRequests,
  summarizeIntakeEvidence,
} from '../server/intake-capture.js'
import { TaskStore, getSeedTasks } from '../server/store.js'

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } })
}

async function withStore(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-intake-'))
  const store = new TaskStore(path.join(root, 'data'))
  try {
    await store.ensureReady()
    store.transaction(() => {
      for (const task of getSeedTasks()) store.insertTask(task)
    })
    await run({ store, root })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

test('маршрути «до» для клієнта, товару й документа проходять GET-only політику проксі', () => {
  for (const kind of ['client', 'product', 'document']) {
    for (const code of ['42607816', '1987302814-BOSCH', 'Ок00000001', 'АМГ "КОНКОРД"', 'A/B 12']) {
      const requests = intakeRequests(kind, code)
      assert.equal(requests.length, 1)
      assert.equal(evaluateDevApiPath(requests[0].path).ok, true, `${kind} ${code}: ${requests[0].path}`)
    }
  }
  assert.match(intakeRequests('client', '42607816')[0].path, /^\/api\/v1\/uk\/clients\/registry\/all\/filtered\?filterSql=RegionCode\.Value\/Client\.FullName\/Client\.USREOU&limit=5&offset=0&value=42607816$/)
  assert.match(intakeRequests('product', 'X1')[0].path, /^\/api\/v1\/uk\/products\/search\/advanced\?value=X1&limit=5&offset=0$/)
  assert.match(intakeRequests('document', '00000633454')[0].path, /^\/api\/v1\/uk\/sales\/ukraine\/registry\?.*&value=00000633454$/)
  assert.deepEqual(intakeRequests('client', '   '), [])
  assert.deepEqual(intakeRequests('order', '1'), [])
})

test('фіксація «до» зберігає статус, кількість і перші 5 обрізаних записів', async () => {
  const seen = []
  const evidence = await captureIntakeEvidence({ entityKind: 'client', entityCode: '42607816' }, {
    proxyBaseUrl: 'http://proxy.test/',
    now: () => new Date('2026-10-20T09:00:00.000Z'),
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      return jsonResponse({
        Body: Array.from({ length: 7 }, (_, index) => ({
          Id: index + 1,
          NetUid: `uid-${index}`,
          Name: `Клієнт ${index}`,
          USREOU: '42607816',
          Comment: 'не потрібне поле',
          ClientAgreements: [{ huge: true }],
        })),
      })
    },
  })
  assert.equal(seen[0].url.startsWith('http://proxy.test/api/v1/uk/clients/registry/all/filtered?'), true)
  assert.equal(seen[0].init.method, 'GET')
  assert.equal(evidence.capturedAt, '2026-10-20T09:00:00.000Z')
  assert.deepEqual(evidence.entity, { kind: 'client', code: '42607816' })
  const [first] = evidence.requests
  assert.equal(first.status, 200)
  assert.equal(first.ok, true)
  assert.equal(first.itemCount, 7)
  assert.equal(first.items.length, 5)
  assert.deepEqual(first.items[0], { Id: 1, NetUid: 'uid-0', Name: 'Клієнт 0', USREOU: '42607816' })
  const summary = summarizeIntakeEvidence(evidence)
  assert.match(summary, /^\[конвеєр:intake\]/)
  assert.match(summary, /200, знайдено 7: Клієнт 0; Клієнт 1; Клієнт 2/)
  assert.equal(isPipelineComment({ body: summary }), true)
})

test('документ показує номер накладної з вкладеного SaleNumber', async () => {
  const evidence = await captureIntakeEvidence({ entityKind: 'document', entityCode: '00000633454' }, {
    proxyBaseUrl: 'http://proxy.test',
    fetchImpl: async () => jsonResponse({ Body: [{ Id: 9, NetUid: 'sale', SaleNumber: { Value: '00000633454' }, ClientAgreement: { Client: { Name: 'ТОВ Альфа' } }, TotalAmount: 13.98 }] }),
  })
  assert.deepEqual(evidence.requests[0].items[0], { Id: 9, NetUid: 'sale', 'SaleNumber.Value': '00000633454', TotalAmount: 13.98, 'ClientAgreement.Client.Name': 'ТОВ Альфа' })
  assert.match(summarizeIntakeEvidence(evidence), /знайдено 1: 00000633454 · ТОВ Альфа/)
})

test('відмова проксі, мережева помилка й відсутня сутність фіксуються без винятку', async () => {
  const refused = await captureIntakeEvidence({ entityKind: 'product', entityCode: 'X1' }, {
    proxyBaseUrl: 'http://proxy.test',
    fetchImpl: async () => jsonResponse({ error: 'DEV API proxy відхилив маршрут' }, { status: 403, headers: { [PROXY_ERROR_HEADER]: 'policy' } }),
  })
  assert.equal(refused.requests[0].ok, false)
  assert.equal(refused.requests[0].status, 403)
  assert.equal(refused.requests[0].proxyError, 'policy')
  assert.match(refused.requests[0].error, /відхилив маршрут/)

  const offline = await captureIntakeEvidence({ entityKind: 'product', entityCode: 'X1' }, {
    proxyBaseUrl: 'http://proxy.test',
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND dev-api-proxy')
    },
  })
  assert.equal(offline.requests[0].status, null)
  assert.match(offline.requests[0].error, /запит не виконано: getaddrinfo ENOTFOUND/)
  assert.match(summarizeIntakeEvidence(offline), /немає відповіді — запит не виконано/)

  assert.equal(await captureIntakeEvidence({ entityKind: '', entityCode: '' }, { fetchImpl: async () => assert.fail('без сутності запитів немає') }), null)
  assert.equal(await captureIntakeEvidence({ entityKind: 'client', entityCode: '  ' }, { fetchImpl: async () => assert.fail('без коду запитів немає') }), null)
})

test('доказ «до» лишається компактним навіть для великих відповідей', async () => {
  const evidence = await captureIntakeEvidence({ entityKind: 'product', entityCode: 'X1' }, {
    proxyBaseUrl: 'http://proxy.test',
    fetchImpl: async () => jsonResponse({ Body: Array.from({ length: 50 }, (_, index) => ({ Id: index, Name: 'Я'.repeat(20_000), VendorCode: 'V'.repeat(20_000) })) }),
  })
  assert.ok(JSON.stringify(evidence).length <= INTAKE_EVIDENCE_MAX_LENGTH)
  assert.equal(evidence.requests[0].itemCount, 50)
})

test('capture зберігає доказ у задачі й додає коментар конвеєра', async () => {
  await withStore(async ({ store }) => {
    store.patch('BUG-1051', { entityKind: 'client', entityCode: '42607816' })
    const capture = createIntakeCapture({
      store,
      proxyBaseUrl: 'http://proxy.test',
      fetchImpl: async () => jsonResponse({ Body: [{ Id: 1, Name: 'АМГ "КОНКОРД" ТОВ', USREOU: '42607816' }] }),
    })
    await capture('BUG-1051')
    const task = store.find('BUG-1051')
    assert.equal(task.intakeEvidence.requests[0].itemCount, 1)
    const comment = store.commentsForTask('BUG-1051').at(-1)
    assert.equal(comment.author, 'QA-конвеєр')
    assert.equal(comment.authorUserId, null)
    assert.match(comment.body, /^\[конвеєр:intake\] Стан «до» на DEV зафіксовано через read-only проксі: Клієнт «42607816»/)
    assert.equal(await capture('BUG-9999'), null)
  })
})

test('старіша база отримує intake-колонки без втрати задач', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-intake-migration-'))
  const dataDirectory = path.join(root, 'data')
  await mkdir(dataDirectory, { recursive: true })
  const legacy = new DatabaseSync(path.join(dataDirectory, 'gba-qa.sqlite'))
  legacy.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      area TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      assignee TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO tasks (id, title, description, area, status, priority, assignee, created_at, updated_at)
    VALUES ('BUG-2001', 'Стара задача', '', 'Продажі', 'new', 'medium', 'QA', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
  `)
  legacy.close()
  const store = new TaskStore(dataDirectory)
  try {
    await store.ensureReady()
    const task = store.find('BUG-2001')
    assert.equal(task.title, 'Стара задача')
    assert.equal(task.entityKind, '')
    assert.equal(task.entityCode, '')
    assert.equal(task.expectedResult, '')
    assert.equal(task.actualResult, '')
    assert.deepEqual(task.intakeEvidence, {})
    store.patch('BUG-2001', { entityKind: 'product', entityCode: 'X1', expectedResult: 'Ціна 10', actualResult: 'Ціна 0' })
    assert.equal(store.find('BUG-2001').actualResult, 'Ціна 0')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function withIntakeApp(run, intakeCapture) {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-intake-api-'))
  const store = new TaskStore(path.join(root, 'data'))
  try {
    const app = await createApp({
      rootDirectory: root,
      dataDirectory: path.join(root, 'data'),
      uploadsDirectory: path.join(root, 'uploads'),
      store,
      authRequired: false,
      internalApiToken: 'test-internal-token',
      intakeCapture,
    })
    await run({ app, store })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

test('API валідує вхідні поля QA і зберігає їх у задачі та знімку AI-запуску', async () => {
  await withIntakeApp(async ({ app, store }) => {
    await request(app).post('/api/tasks').field('title', 'Невідома сутність').field('entityKind', 'order').field('entityCode', '1').expect(400)
    await request(app).post('/api/tasks').field('title', 'Без коду').field('entityKind', 'client').expect(400)
    await request(app).post('/api/tasks').field('title', 'Код без типу').field('entityCode', '42607816').expect(400)
    await request(app).post('/api/tasks').field('title', 'Задовгий код').field('entityKind', 'product').field('entityCode', 'x'.repeat(121)).expect(400)

    const created = await request(app)
      .post('/api/tasks')
      .field('title', 'Ціна товару нульова')
      .field('entityKind', 'product')
      .field('entityCode', '1987302814-BOSCH')
      .field('expectedResult', 'Ціна 26.40 EUR')
      .field('actualResult', 'Ціна 0')
      .expect(201)
    assert.equal(created.body.entityKind, 'product')
    assert.equal(created.body.entityCode, '1987302814-BOSCH')
    assert.equal(created.body.expectedResult, 'Ціна 26.40 EUR')
    assert.equal(created.body.actualResult, 'Ціна 0')
    assert.deepEqual(created.body.intakeEvidence, {})
    const snapshot = store.find(created.body.id).agentRun.inputSnapshot
    assert.equal(snapshot.entityKind, 'product')
    assert.equal(snapshot.expectedResult, 'Ціна 26.40 EUR')

    const patched = await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .send({ actualResult: 'Ціна 0.00 після перезапуску' })
      .expect(200)
    assert.equal(patched.body.actualResult, 'Ціна 0.00 після перезапуску')
    assert.equal(patched.body.entityCode, '1987302814-BOSCH')
  }, null)
})

test('201 повертається до завершення фіксації «до», а AI-запуск стартує вже з доказом', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const calls = []
  let storeRef
  await withIntakeApp(async ({ app, store }) => {
    storeRef = store
    const created = await request(app)
      .post('/api/tasks')
      .field('title', 'Клієнт без договорів')
      .field('entityKind', 'client')
      .field('entityCode', '42607816')
      .expect(201)
    assert.equal(created.body.agentRun, null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(calls, [created.body.id])
    assert.equal(store.find(created.body.id).agentRun, null)

    release()
    for (let attempt = 0; attempt < 50 && !store.find(created.body.id).agentRun; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const task = store.find(created.body.id)
    assert.equal(task.agentRun.status, 'queued')
    assert.equal(task.agentRun.inputSnapshot.intakeEvidence.requests[0].itemCount, 2)
    assert.ok(task.agentRun.inputSnapshot.comments.some((comment) => comment.body.startsWith('[конвеєр:intake]')))

    const plain = await request(app).post('/api/tasks').field('title', 'Без сутності').expect(201)
    assert.equal(plain.body.agentRun.status, 'queued')
    assert.deepEqual(calls, [created.body.id])
  }, async (taskId) => {
    calls.push(taskId)
    await gate
    storeRef.saveIntakeEvidence(taskId, { requests: [{ label: 'x', path: '/api/v1/uk/x', status: 200, ok: true, itemCount: 2, items: [] }] })
    storeRef.addTaskComment('intake-comment', taskId, { author: 'QA-конвеєр', authorUserId: null, parentId: null, body: '[конвеєр:intake] знайдено 2' })
  })
})

test('збій фіксації «до» не блокує AI-запуск', async () => {
  await withIntakeApp(async ({ app, store }) => {
    const created = await request(app)
      .post('/api/tasks')
      .field('title', 'Проксі недоступний')
      .field('entityKind', 'document')
      .field('entityCode', '00000633454')
      .expect(201)
    for (let attempt = 0; attempt < 50 && !store.find(created.body.id).agentRun; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(store.find(created.body.id).agentRun.status, 'queued')
  }, async () => {
    throw new Error('proxy down')
  })
})
