import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ErrorGroupCollector,
  buildTaskDraft,
  fingerprintGroup,
  isContinuationLine,
  normalizeForFingerprint,
  parseContainerSpec,
  parseIgnorePatterns,
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
