import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ErrorGroupCollector,
  buildTaskDraft,
  evaluateMaintenance,
  fingerprintGroup,
  isBelowErrorLevel,
  isContinuationLine,
  isRecordStart,
  normalizeForFingerprint,
  parseContainerList,
  parseContainerSpec,
  parseIgnorePatterns,
  parseMaintenanceEnvRules,
} from '../server/log-sentinel.js'

test('нормалізація прибирає мінливі частини — відбиток стабільний', () => {
  const first = fingerprintGroup('api', [
    '13:17:19.875 ERROR [c06a5b64e2fb4445ada95d3a2af5d4ba] GlobalExceptionHandler | Client name is invalid.',
  ])
  const second = fingerprintGroup('api', [
    '09:01:02.003 ERROR [ffffffffffffffffffffffffffffffff] GlobalExceptionHandler | Client name is invalid.',
  ])
  const other = fingerprintGroup('api', [
    '09:01:02.003 ERROR [ffffffffffffffffffffffffffffffff] GlobalExceptionHandler | Email is invalid.',
  ])

  assert.equal(first, second)
  assert.notEqual(first, other)
  assert.match(first, /^[0-9a-f]{12}$/)
})

test('відбиток залежить від контейнера', () => {
  const line = ['ERROR Something failed']
  assert.notEqual(fingerprintGroup('api', line), fingerprintGroup('shop', line))
})

test('колектор групує стек-трейс і флашить за тишею', async () => {
  const groups = []
  const collector = new ErrorGroupCollector({
    matcher: /ERROR|Exception/,
    quietMs: 30,
    onGroup: (lines) => groups.push(lines),
  })

  collector.feed('12:00:00.000 INFO все добре')
  collector.feed('12:00:01.000 ERROR Unhandled exception')
  collector.feed('   at GBA.Services.DoWork()')
  collector.feed('   at GBA.Api.Controller()')
  await new Promise((resolve) => setTimeout(resolve, 80))
  collector.feed('12:00:02.000 INFO знову добре')

  assert.equal(groups.length, 1)
  assert.equal(groups[0].length, 3)
  assert.equal(groups[0][1], '   at GBA.Services.DoWork()')
})

test('колектор поважає ignore-патерни', async () => {
  const groups = []
  const collector = new ErrorGroupCollector({
    matcher: /ERROR/,
    ignore: parseIgnorePatterns('too_many_nested_clauses~~Too many requests'),
    quietMs: 20,
    onGroup: (lines) => groups.push(lines),
  })

  collector.feed('ERROR Elasticsearch failed: too_many_nested_clauses')
  collector.feed('ERROR справжня нова помилка')
  await new Promise((resolve) => setTimeout(resolve, 60))

  assert.equal(groups.length, 1)
  assert.match(groups[0][0], /справжня/)
})

test('колектор зберігає деталі винятку без стандартного префікса продовження', () => {
  const groups = []
  const collector = new ErrorGroupCollector({
    matcher: /\bERROR\b/,
    quietMs: 5,
    onGroup: (group) => groups.push(group),
  })

  collector.feed('16:43:01.782 ERROR [5c81e9ce] SearchSyncHealthProbe | Elasticsearch product readiness probe failed ')
  collector.feed('System.Net.Http.HttpRequestException')
  collector.feed('Connection refused (elasticsearch:9200)')
  collector.feed('Void MoveNext()')
  collector.feed('16:43:02.043 ERROR [5c81e9ce] DefaultHealthCheckService | Health check search-index failed')
  collector.flush()
  collector.feed('[ERROR][21.09.2026 16:49:49][Thread 0003][akka://MainSystem/user/TaxFrees] TaxFree document publication recovery failed.')
  collector.feed('Cause: Microsoft.Data.SqlClient.SqlException (0x80131904): A network-related error occurred')
  collector.feed('[INFO][21.09.2026 16:49:50][Thread 0004][akka://MainSystem/user] ok')
  collector.flush()

  assert.equal(groups.length, 3)
  assert.deepEqual(groups[0].slice(2), ['Connection refused (elasticsearch:9200)', 'Void MoveNext()'])
  assert.equal(groups[1].length, 1)
  assert.match(groups[2][1], /^Cause: .*SqlException/)
  assert.equal(groups[2].length, 2)
})

test('початок нового запису логу розпізнається', () => {
  assert.equal(isRecordStart('12:00:00.000 ERROR Boom'), true)
  assert.equal(isRecordStart('[ERROR][21.09.2026 16:49:49][Thread 0003] x'), true)
  assert.equal(isRecordStart('2026-09-21T16:43:00.755Z INFO ok'), true)
  assert.equal(isRecordStart('ERROR справжня нова помилка'), true)
  assert.equal(isRecordStart('Connection refused (elasticsearch:9200)'), false)
  assert.equal(isRecordStart('Cause: System.InvalidOperationException: x'), false)
})

test('продовження стеку розпізнається', () => {
  assert.equal(isContinuationLine('   at Foo.Bar()'), true)
  assert.equal(isContinuationLine('System.NullReferenceException: x'), true)
  assert.equal(isContinuationLine('12:00:00 INFO ok'), false)
})

test('конфіг контейнерів парситься', () => {
  const containers = parseContainerSpec('a-1|console|Сервер~~b-2|ecommerce|Магазин')
  assert.deepEqual(containers.map((c) => c.project), ['console', 'ecommerce'])
  assert.equal(containers[1].label, 'Магазин')
})

test('чернетка задачі містить маркер і проєкт', () => {
  const draft = buildTaskDraft(
    { name: 'api-1', project: 'ecommerce', label: 'Ecommerce API' },
    ['12:00 ERROR Boom happened', '   at GBA.Do()'],
    'abcdefabcdef',
    '2026.08.06',
  )
  assert.match(draft.title, /^\[AUTO\] Ecommerce API/)
  assert.equal(draft.project, 'ecommerce')
  assert.match(draft.notes, /\[sentinel:abcdefabcdef\]/)
  assert.match(draft.notes, /Boom happened/)
})

test('нормалізація текстів працює для дат і guid', () => {
  const normalized = normalizeForFingerprint('2026-08-06T15:01:03.122475Z guid 0c1d2e3f-1111-2222-3333-444455556666 num 123456')
  assert.doesNotMatch(normalized, /2026|0c1d2e3f|123456/)
})

test('відкладений відбиток не довбить desk повторно у вікні backoff', async () => {
  const { LogSentinel } = await import('../server/log-sentinel.js')
  const sentinel = new LogSentinel({
    containers: [],
    dataDirectory: '/tmp',
    maxTasksPerHour: 0,
    suppressBackoffMs: 60_000,
  })
  sentinel.state = { fingerprints: {}, created: [] }
  sentinel.saveState = async () => {}

  let deskLookups = 0
  sentinel.findTaskByMarker = async () => { deskLookups += 1; return null }
  sentinel.createDeskTask = async () => { throw new Error('не має створюватись') }

  const container = { name: 'api-1', project: 'console', label: 'API' }
  const lines = ['12:00:00.000 ERROR щось зламалось']

  await sentinel.handleGroup(container, lines)
  await sentinel.handleGroup(container, lines)
  await sentinel.handleGroup(container, lines)

  const [entry] = Object.values(sentinel.state.fingerprints)
  assert.equal(deskLookups, 1)
  assert.equal(entry.suppressed, true)
  assert.equal(entry.count >= 2, true)
})

test('WARN-рядок від GlobalExceptionHandler не заводить задачу', () => {
  const groups = []
  const collector = new ErrorGroupCollector({
    matcher: /\bERROR\b|\bFATAL\b|Unhandled|Unobserved|Exception|Traceback|⨯/,
    quietMs: 5,
    onGroup: (group) => groups.push(group),
  })

  collector.feed('21:06:06.416 WARN  [e258645030c3] GlobalExceptionHandler | Order must contain between 1 and 100 items.')
  collector.flush()
  assert.deepEqual(groups, [])

  collector.feed('15:24:49.118 ERROR [b759da1ed142] GlobalExceptionHandler | Index was out of range.')
  collector.flush()
  assert.equal(groups.length, 1)
})

test('рівень нижче ERROR розпізнається лише коли він справді рівень', () => {
  assert.equal(isBelowErrorLevel('20:00:33 WARN  [abc] Handler | щось'), true)
  assert.equal(isBelowErrorLevel('20:00:33 ERROR [abc] Handler | щось'), false)
  assert.equal(isBelowErrorLevel('System.ArgumentOutOfRangeException: Index was out of range'), false)
  assert.equal(isBelowErrorLevel('[ERROR][06.08.2026 15:50:18][Thread 0214] akka://MainSystem'), false)
})

test('Akka WARNING та INFO нижче ERROR, навіть коли рядок згадує Exception', () => {
  assert.equal(isBelowErrorLevel('[WARNING][01.10.2026 09:37:16][Thread 0003][akka://MainSystem/user/MasterActor/DiscountOrdinaryBackground] DISCOUNT_ORDINARY_BACKGROUND_RETRY kind=InvalidOperationException delaySeconds=300'), true)
  assert.equal(isBelowErrorLevel('[INFO][17.10.2026 12:38:22][Thread 0087][akka://MainSystem/deadLetters] Message [Failure] from [akka://MainSystem/temp/1] was not delivered.'), true)
  assert.equal(isBelowErrorLevel('[ERROR][14.10.2026 11:09:57][Thread 0087][StandardOutLogger] Encountered System.FormatException while recording log: [WARNING][akka://MainSystem/user/MasterActor/DataSyncManagement].'), false)

  const groups = []
  const collector = new ErrorGroupCollector({
    matcher: /\bERROR\b|\bFATAL\b|Unhandled|Unobserved|Exception|Traceback|⨯/,
    quietMs: 5,
    onGroup: (group) => groups.push(group),
  })
  collector.feed('[WARNING][10/05/2026 08:10:59][Thread 0187][akka://MainSystem/user/MasterActor/ManagementTurnoverPeriodBackground] MANAGEMENT_TURNOVER_PERIOD_RETRY kind=SqlException delaySeconds=31')
  collector.flush()
  assert.deepEqual(groups, [])
})

test('відбиток Akka-запису не залежить від часу, культури дати, потоку та імені дочірнього актора', () => {
  const first = fingerprintGroup('api', [
    '[ERROR][07.10.2026 05:55:25][Thread 0186][akka://MainSystem/user/MasterActor/SupplyManagement/SupplyUkraineManagement/TaxFrees] TaxFree document publication recovery failed.',
    'Cause: Microsoft.Data.SqlClient.SqlException (0x80131904): Execution Timeout Expired.',
  ])
  const second = fingerprintGroup('api', [
    '[ERROR][10/18/2026 13:17:58][Thread 0202][akka://MainSystem/user/MasterActor/SupplyManagement/SupplyUkraineManagement/TaxFrees] TaxFree document publication recovery failed.',
    'Cause: Microsoft.Data.SqlClient.SqlException (0x80131904): Execution Timeout Expired.',
  ])
  const other = fingerprintGroup('api', [
    '[ERROR][07.10.2026 05:55:25][Thread 0186][akka://MainSystem/user/MasterActor/SupplyManagement/SupplyUkraineManagement/TaxFrees] TaxFree document publication failed.',
  ])
  const workerA = fingerprintGroup('api', ['[ERROR][10/07/2026 04:20:22][Thread 0085][akka://MainSystem/user/MasterActor/SalesManagement/SalesPaymentDocumentWorker/$a] Unhandled sales actor failure.'])
  const workerB = fingerprintGroup('api', ['[ERROR][07.10.2026 09:01:02][Thread 0113][akka://MainSystem/user/MasterActor/SalesManagement/SalesPaymentDocumentWorker/$b] Unhandled sales actor failure.'])

  assert.equal(first, second)
  assert.notEqual(first, other)
  assert.equal(workerA, workerB)
  assert.doesNotMatch(normalizeForFingerprint('[ERROR][06.10.2026 18:22:26][Thread 0183]'), /06\.10|18:22:26|0183/)
})

test('правила обслуговування за змінними оточення парсяться', () => {
  assert.deepEqual(parseMaintenanceEnvRules('gba-dev-data-concord-1:Maintenance__Enabled=true~~broken~~x:=1'), [
    { container: 'gba-dev-data-concord-1', key: 'Maintenance__Enabled', value: 'true' },
  ])
  assert.deepEqual(parseContainerList(' a ~~~~b'), ['a', 'b'])
})

test('обслуговування DEV розпізнається за cutover-прапорцем, зупиненим fence-контейнером і перезапуском залежності', () => {
  const now = Date.parse('2026-10-18T13:10:00Z')
  const running = (startedAt = '2026-10-01T00:00:00Z', env = []) => ({ State: { Running: true, StartedAt: startedAt }, Config: { Env: env } })
  const base = {
    envRules: parseMaintenanceEnvRules('api:Maintenance__Enabled=true'),
    fences: ['console'],
    dependencies: ['mssql'],
    graceMs: 120_000,
    now,
  }
  const healthy = new Map([['api', running(undefined, ['Maintenance__Enabled=false'])], ['console', running()], ['mssql', running()]])
  assert.equal(evaluateMaintenance({ ...base, inspected: healthy }), null)

  const fenced = new Map(healthy).set('api', running(undefined, ['Maintenance__Enabled=True']))
  assert.match(evaluateMaintenance({ ...base, inspected: fenced }), /api: Maintenance__Enabled=True/)

  const consoleStopped = new Map(healthy).set('console', { State: { Running: false, StartedAt: '2026-10-18T13:05:00Z' }, Config: { Env: [] } })
  assert.match(evaluateMaintenance({ ...base, inspected: consoleStopped }), /console: контейнер зупинено/)

  const consoleMissing = new Map(healthy)
  consoleMissing.delete('console')
  assert.match(evaluateMaintenance({ ...base, inspected: consoleMissing }), /console: контейнер відсутній/)

  const consoleJustStarted = new Map(healthy).set('console', running('2026-10-18T13:09:50Z'))
  assert.equal(evaluateMaintenance({ ...base, inspected: consoleJustStarted }), null)

  const sqlRestarted = new Map(healthy).set('mssql', running('2026-10-18T13:09:00Z'))
  assert.match(evaluateMaintenance({ ...base, inspected: sqlRestarted }), /mssql: перезапущено 60 с тому/)

  const sqlSettled = new Map(healthy).set('mssql', running('2026-10-18T13:07:00Z'))
  assert.equal(evaluateMaintenance({ ...base, inspected: sqlSettled }), null)
})

test('під час обслуговування DEV вартовий не заводить задач і не чіпає desk', async () => {
  const { LogSentinel } = await import('../server/log-sentinel.js')
  let running = false
  let inspections = 0
  const sentinel = new LogSentinel({
    containers: [],
    dataDirectory: '/tmp',
    maintenanceFences: ['gba-dev-gba-console-1'],
    maintenanceCacheMs: 0,
  })
  sentinel.state = { fingerprints: {}, created: [] }
  sentinel.saveState = async () => {}
  sentinel.inspectContainer = async () => {
    inspections += 1
    return { State: { Running: running, StartedAt: '2026-10-18T13:00:00Z' }, Config: { Env: [] } }
  }
  let deskLookups = 0
  const created = []
  sentinel.findTaskByMarker = async () => { deskLookups += 1; return null }
  sentinel.createDeskTask = async (draft) => { created.push(draft); return { id: 'BUG-1' } }

  const container = { name: 'gba-dev-data-concord-1', project: 'console', label: 'GBA Server' }
  const lines = ['[ERROR][18.10.2026 13:07:58][Thread 0193][akka://MainSystem/user/TaxFrees] TaxFree document publication recovery failed.']

  await sentinel.handleGroup(container, lines)
  assert.equal(deskLookups, 0)
  assert.equal(created.length, 0)
  assert.deepEqual(sentinel.state.fingerprints, {})
  assert.equal(sentinel.maintenanceSkipped, 1)

  running = true
  await sentinel.handleGroup(container, lines)
  assert.equal(created.length, 1)
  assert.equal(inspections, 2)
})

test('стан обслуговування кешується, а збій docker API не глушить вартового', async () => {
  const { LogSentinel } = await import('../server/log-sentinel.js')
  let inspections = 0
  const sentinel = new LogSentinel({ containers: [], dataDirectory: '/tmp', maintenanceDependencies: ['mssql'], maintenanceCacheMs: 5000 })
  sentinel.inspectContainer = async () => { inspections += 1; return { State: { Running: false }, Config: { Env: [] } } }
  assert.match(await sentinel.maintenanceReason(1000), /mssql/)
  assert.match(await sentinel.maintenanceReason(3000), /mssql/)
  assert.equal(inspections, 1)

  const broken = new LogSentinel({ containers: [], dataDirectory: '/tmp', maintenanceFences: ['console'] })
  broken.dockerJson = async () => { throw new Error('connect ENOENT /var/run/docker.sock') }
  const originalError = console.error
  console.error = () => {}
  try {
    assert.equal(await broken.maintenanceReason(), null)
  } finally {
    console.error = originalError
  }

  const missing = new LogSentinel({ containers: [], dataDirectory: '/tmp', maintenanceFences: ['console'] })
  missing.dockerJson = async (requestPath) => { throw new Error(`docker API 404 for ${requestPath}`) }
  assert.match(await missing.maintenanceReason(), /console: контейнер відсутній/)

  const unconfigured = new LogSentinel({ containers: [], dataDirectory: '/tmp' })
  unconfigured.inspectContainer = async () => { throw new Error('не має викликатись') }
  assert.equal(await unconfigured.maintenanceReason(), null)
})
