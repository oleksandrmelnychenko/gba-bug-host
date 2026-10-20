import assert from 'node:assert/strict'
import test from 'node:test'
import {
  codexSessionIdFromEventLine,
  composePersistentContext,
  composePriorRunsContext,
  createCodexSessionTracker,
  decideCodexSession,
  isPipelineComment,
} from '../server/codex-context.js'

test('постійний контекст містить лише підтверджені передані release-и та маскує secrets', () => {
  const context = composePersistentContext({
    project: 'console',
    baseContext: 'Основний контекст. ApiKey=super-secret-value',
    generatedAt: '2026-08-08T12:00:00.000Z',
    releasedRuns: [{
      taskId: 'BUG-2001',
      title: 'Виправлено синк',
      area: 'Синхронізація',
      summary: 'Додано idempotency. sk-ant-example-secret-value-1234567890',
      details: JSON.stringify({ changedFiles: ['server/sync.js'] }),
      releasedAt: '2026-08-08T11:00:00.000Z',
    }],
  })

  assert.match(context, /BUG-2001/)
  assert.match(context, /server\/sync\.js/)
  assert.match(context, /ApiKey=\[REDACTED\]/)
  assert.match(context, /\[REDACTED_API_KEY\]/)
  assert.doesNotMatch(context, /super-secret-value/)
})

test('Codex session tracker дістає thread id із розбитого JSONL потоку лише зі службової події', () => {
  const detected = []
  const tracker = createCodexSessionTracker((sessionId) => detected.push(sessionId))
  tracker.consume('{"type":"item.completed","payload":{"session_id":"pty-123"}}\n{"type":"thread.')
  tracker.consume('started","thread_id":"019fe123-aabb-7ccd-8eef-0123456789ab"}\n')

  assert.equal(tracker.finish(), '019fe123-aabb-7ccd-8eef-0123456789ab')
  assert.deepEqual(detected, ['019fe123-aabb-7ccd-8eef-0123456789ab'])
  assert.equal(codexSessionIdFromEventLine('{"type":"item.completed","session_id":"wrong"}'), '')
})

const now = Date.parse('2026-10-20T12:00:00.000Z')
const completedRun = {
  id: 'RUN-1',
  status: 'completed',
  releaseStatus: 'released',
  releasePhase: 'released',
  sessionMode: 'fresh',
  codexModel: 'gpt-6-astra',
  codexSessionId: 'session-1',
  finishedAt: '2026-10-20T10:00:00.000Z',
}
const reviewRun = { id: 'RUN-2', trigger: 'review_again', sessionMode: '' }

test('Codex-сесія продовжується лише для швидкого review-again після completed на тій самій моделі', () => {
  const decide = (overrides = {}, run = reviewRun, extra = {}) => decideCodexSession({
    run,
    previousRun: { ...completedRun, ...overrides },
    model: 'gpt-6-astra',
    mainlineDrift: 3,
    now,
    ...extra,
  })
  assert.deepEqual(decide(), { mode: 'resume', reason: 'quick-follow-up', sessionId: 'session-1' })
  assert.equal(decideCodexSession({ run: reviewRun, previousRun: null, now }).reason, 'first-run')
  assert.equal(decide({}, { trigger: 'manual', sessionMode: '' }).reason, 'trigger:manual')
  assert.equal(decide({}, { trigger: 'manual', triggerReason: 'verification_failed', sessionMode: '' }).mode, 'fresh')
  assert.equal(decide({ status: 'needs_review' }).reason, 'previous-verdict:needs_review')
  assert.equal(decide({ status: 'failed' }).reason, 'previous-verdict:failed')
  assert.equal(decide({ releaseStatus: 'blocked', releasePhase: 'failed' }).reason, 'previous-release-failed')
  assert.equal(decide({ sessionMode: '' }).reason, 'previous-run-legacy')
  assert.equal(decide({ finishedAt: '2026-10-19T23:59:59.000Z' }).reason, 'previous-run-older-than-12h')
  assert.equal(decide({ codexModel: 'gpt-6-sol' }).reason, 'model-changed:gpt-6-sol->gpt-6-astra')
  assert.equal(decide({}, reviewRun, { mainlineDrift: 21 }).reason, 'mainline-moved:21-commits')
  assert.equal(decide({}, reviewRun, { mainlineDrift: 20 }).mode, 'resume')
  assert.equal(decide({}, reviewRun, { mainlineDrift: null }).reason, 'mainline-drift-unknown')
  assert.equal(decide({ codexSessionId: '' }).reason, 'previous-session-missing')
  assert.deepEqual(
    decideCodexSession({ run: { trigger: 'manual', sessionMode: 'fresh', codexSessionId: 'own-session' }, previousRun: null, now }),
    { mode: 'resume', reason: 'interrupted-run', sessionId: 'own-session' },
  )
})

test('блок «Попередні рани» стисло переносить вердикт, коміти, release і коментарі без роздуття', () => {
  const runs = [
    {
      id: 'RUN-2',
      attempt: 2,
      trigger: 'manual',
      status: 'needs_review',
      createdAt: '2026-10-20T09:00:00.000Z',
      finishedAt: '2026-10-20T09:30:00.000Z',
      summary: 'DEV API відповів 401, сценарій не відтворено.',
      details: JSON.stringify({ outcome: 'needs_review', blocker: 'DEV API 401 без авторизованої сесії на /clients/get/search' }),
      branch: 'codex/qa-bug-1389',
      headCommits: { 'gba-server': { commit: 'c'.repeat(40), dirty: true } },
      releaseStatus: 'blocked',
      releasePhase: 'failed',
      releaseError: 'AI-результат потребує змістовного перегляду до release.',
      sessionMode: 'fresh',
      sessionReason: 'first-run',
    },
    {
      id: 'RUN-1',
      attempt: 1,
      trigger: 'manual',
      status: 'completed',
      createdAt: '2026-10-19T09:00:00.000Z',
      finishedAt: '2026-10-19T09:30:00.000Z',
      summary: 'Виправлено пікер клієнтів.',
      details: JSON.stringify({ outcome: 'fixed', rootCause: 'Пошук повертав синтетичну папку.', changedFiles: ['gba-server/src/Clients.cs'] }),
      branch: 'codex/qa-bug-1389',
      releaseStatus: 'released',
      releasePhase: 'released',
      releaseEvidence: { repositories: { 'gba-server': { commit: 'a'.repeat(40), branch: 'main' } }, liveVerification: { passed: true, report: 'PASS: 1/1' } },
    },
  ]
  const comments = [
    { id: 'c1', author: 'QA', body: 'Досі бачу папку замість клієнта', createdAt: '2026-10-19T12:00:00.000Z' },
    { id: 'c2', author: 'QA', body: 'Після другої спроби 401', createdAt: '2026-10-20T10:00:00.000Z' },
  ]
  const block = composePriorRunsContext({ runs, comments })
  assert.ok(block.indexOf('Спроба #1') < block.indexOf('Спроба #2'))
  assert.match(block, /вердикт: completed\/fixed/)
  assert.match(block, /gba-server@aaaaaaaaaaaa \(у main\)/)
  assert.match(block, /gba-server@cccccccccccc \+ незакомічені зміни/)
  assert.match(block, /Live-перевірка DEV: PASS/)
  assert.match(block, /Блокер: DEV API 401/)
  assert.match(block, /\[c1\] QA: Досі бачу папку/)
  assert.match(block, /\[c2\] QA: Після другої спроби 401/)
  assert.ok(composePriorRunsContext({ runs, comments, maximumLength: 400 }).length <= 400)
  assert.equal(composePriorRunsContext({ runs: [] }), '')
})

test('коментарі конвеєра розпізнаються за машинним маркером', () => {
  assert.equal(isPipelineComment({ body: '[конвеєр:released] Випущено' }), true)
  assert.equal(isPipelineComment({ body: 'QA: [конвеєр:released] у тексті' }), false)
  assert.equal(isPipelineComment({ body: 'звичайний коментар' }), false)
})

test('reasoning effort підвищується для SQL, синку та мультирепо-задач і ніколи не знижується', async () => {
  const { selectReasoningEffort } = await import('../server/codex-context.js')
  assert.deepEqual(selectReasoningEffort({ task: { title: 'Кнопка не того кольору' }, baseEffort: 'high' }), { effort: 'high', reason: 'default' })
  assert.deepEqual(selectReasoningEffort({ task: { title: 'Повільний SQL у звіті' }, baseEffort: 'high' }), { effort: 'xhigh', reason: 'sql' })
  assert.equal(selectReasoningEffort({ task: { description: 'Синхронізація з 1С губить рухи' } }).reason, 'sync')
  assert.equal(selectReasoningEffort({
    task: { title: 'Договори клієнта' },
    priorRuns: [{ details: JSON.stringify({ changedFiles: ['gba_console/src/a.tsx', 'gba-server/src/b.cs'] }) }],
  }).reason, 'multi-repo')
  assert.equal(selectReasoningEffort({ task: { title: 'Повільний SQL' }, baseEffort: 'max' }).effort, 'max')
  assert.equal(selectReasoningEffort({ task: { title: 'Текст', comments: [{ body: '[конвеєр:blocked] SQL' }] } }).reason, 'default')
})

test('урок додається лише якщо він новий для проєкту і потрапляє в постійний контекст', async () => {
  const { appendLesson, composeLessonsSection } = await import('../server/codex-context.js')
  let state = { items: [] }
  let result = appendLesson(state, { text: 'Пошук клієнтів у продажі має відкидати синтетичні папки 1С за IsFolder', taskId: 'BUG-1389', project: 'console' })
  assert.equal(result.changed, true)
  state = result.state
  result = appendLesson(state, { text: 'пошук клієнтів у продажі має відкидати синтетичні папки 1с (IsFolder)', taskId: 'BUG-1400', project: 'console' })
  assert.equal(result.changed, false)
  result = appendLesson(state, { text: 'ok', taskId: 'BUG-1401', project: 'console' })
  assert.equal(result.changed, false)
  result = appendLesson(state, { text: 'Пошук клієнтів у продажі має відкидати синтетичні папки 1С за IsFolder', taskId: 'BUG-1402', project: 'ecommerce' })
  assert.equal(result.changed, true)
  const section = composeLessonsSection(result.state, 'console')
  assert.match(section, /Уроки попередніх задач/)
  assert.match(section, /BUG-1389/)
  assert.doesNotMatch(section, /BUG-1402/)
  const context = composePersistentContext({ project: 'console', baseContext: 'Основа', lessons: section, generatedAt: 'now' })
  assert.match(context, /відкидати синтетичні папки/)
})
