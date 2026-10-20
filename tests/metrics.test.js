import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import request from 'supertest'
import { createApp } from '../server/app.js'
import {
  classifyRunOutcome,
  computeMetrics,
  distribution,
  normalizeRun,
  parseMarkerEvents,
  percentile,
  weekStart,
} from '../server/metrics.js'
import { TaskStore } from '../server/store.js'

const now = Date.parse('2026-10-20T12:00:00.000Z')
const minutes = (value) => value * 60_000
const at = (minutesAgo) => new Date(now - minutes(minutesAgo)).toISOString()

function runRow(overrides = {}) {
  return {
    id: `RUN-${Math.random().toString(16).slice(2)}`,
    task_id: 'BUG-1',
    trigger: 'manual',
    trigger_reason: '',
    status: 'completed',
    attempt: 1,
    error: '',
    details: '{}',
    release_status: 'released',
    release_phase: 'released',
    release_error: '',
    release_evidence: '{}',
    released_at: at(100),
    created_at: at(200),
    started_at: at(190),
    finished_at: at(160),
    heartbeat_at: null,
    updated_at: at(100),
    ...overrides,
  }
}

function taskRow(overrides = {}) {
  return {
    id: 'BUG-1',
    title: 'Задача',
    status: 'ready_for_retest',
    notes: '',
    project: 'console',
    ai_mode: 'auto',
    created_at: at(300),
    updated_at: at(90),
    ...overrides,
  }
}

test('percentile бере nearest-rank і ігнорує порожні значення', () => {
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([5], 90), 5)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5)
  assert.equal(percentile([10, 1, 9, 2, 8, 3, 7, 4, 6, 5], 90), 9)
  assert.deepEqual(distribution([null, 4, Number.NaN, 2]), { count: 2, p50: 2, p90: 4 })
  assert.equal(weekStart(Date.parse('2026-10-20T12:00:00.000Z')), '2026-10-19')
  assert.equal(weekStart(Date.parse('2026-10-19T00:00:00.000Z')), '2026-10-19')
  assert.equal(weekStart(Date.parse('2026-10-25T23:59:00.000Z')), '2026-10-19')
})

test('класифікація причин розрізняє людські, інфраструктурні й release-зупинки', () => {
  const classify = (overrides) => classifyRunOutcome(normalizeRun(runRow(overrides)))
  assert.equal(classify({}), 'released')
  assert.equal(classify({ status: 'running', release_status: 'pending' }), 'running')
  assert.equal(classify({ release_status: 'waiting_mainline' }), 'waiting_mainline')
  assert.equal(classify({ status: 'blocked', error: 'Зупинено оператором.', release_status: 'blocked' }), 'stopped')
  assert.equal(classify({ status: 'failed', error: 'You have hit your usage limit', release_status: 'blocked' }), 'codex_usage_limit')
  assert.equal(classify({ status: 'failed', error: 'Codex перевищив таймаут 90 хв.', release_status: 'blocked' }), 'codex_failed')
  assert.equal(classify({ status: 'needs_review', release_status: 'blocked', details: JSON.stringify({ qualityGate: { applied: true, passed: false } }) }), 'quality_gate')
  assert.equal(classify({ status: 'needs_review', release_status: 'blocked' }), 'needs_review')
  assert.equal(classify({ release_status: 'blocked', release_error: 'live-перевірка не пройшла: live spec не пройшов на DEV', release_evidence: JSON.stringify({ liveVerification: { passed: false } }) }), 'live_verification_failed')
  assert.equal(classify({ release_status: 'blocked', release_phase: 'failed', release_error: 'gba_console: перевірка «npx vitest run» впала; mainline не змінено' }), 'mainline_red')
  assert.equal(classify({
    release_status: 'blocked',
    release_phase: 'failed',
    release_error: 'gba_console: перевірка «npx vitest run» впала; на чистому origin/main гейт зелений — падіння внесла задача',
    release_evidence: JSON.stringify({ failure: { phase: 'validating', mainlineGate: { status: 'green' } } }),
  }), 'release_blocked:validating')
  assert.equal(classify({ release_status: 'blocked', release_phase: 'failed', release_error: 'Деплой не пройшов', release_evidence: JSON.stringify({ failure: { phase: 'deploying' } }) }), 'release_blocked:deploying')
  assert.equal(classify({ release_status: 'processing', released_at: null }), 'in_release')
})

test('маркери нотаток стають подіями хронології', () => {
  const events = parseMarkerEvents([
    '[release-waiting-mainline:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] червоний',
    '[release-blocked:2026-10-19T20:19:08.038Z] 3 невдалих спроби',
    '[released:2026-08-07 00:20] legacy',
    '[live-verify-failed:2026-10-20T10:00:00.000Z] FAIL',
  ].join('\n'))
  assert.deepEqual(events.map((event) => event.kind).sort(), ['live_verify_failed', 'release_blocked', 'released', 'waiting_mainline'])
  assert.equal(events.find((event) => event.kind === 'released').at, '2026-08-07T00:20:00.000Z')
  assert.equal(events.find((event) => event.kind === 'waiting_mainline').detail, 'aaaaaaaaaaaa')
})

test('метрики рахують частку релізів, перцентилі, тижні, причини й сигнали', () => {
  const tasks = [
    taskRow({ id: 'BUG-1' }),
    taskRow({ id: 'BUG-2' }),
    taskRow({ id: 'BUG-3', status: 'blocked' }),
    taskRow({ id: 'BUG-4', status: 'in_progress', updated_at: at(130) }),
    taskRow({ id: 'BUG-5', status: 'in_progress', updated_at: at(70) }),
    taskRow({ id: 'BUG-6', status: 'in_progress', updated_at: at(5) }),
    taskRow({ id: 'BUG-7', status: 'new', title: 'MAIN RED gba_console@abc' }),
    taskRow({ id: 'BUG-8', status: 'in_progress', updated_at: at(200) }),
    taskRow({ id: 'BUG-9', status: 'blocked', ai_mode: 'off' }),
    taskRow({ id: 'BUG-10', status: 'blocked' }),
  ]
  const runs = [
    runRow({ task_id: 'BUG-1', finished_at: at(160), released_at: at(140), created_at: at(200), started_at: at(190) }),
    runRow({ task_id: 'BUG-2', finished_at: at(160), released_at: at(70), created_at: at(300), started_at: at(200) }),
    runRow({ task_id: 'BUG-3', status: 'needs_review', release_status: 'blocked', released_at: null, details: JSON.stringify({ qualityGate: { applied: true, passed: false } }) }),
    runRow({ task_id: 'BUG-4', status: 'running', release_status: 'pending', released_at: null, finished_at: null, started_at: at(50), created_at: at(60) }),
    runRow({
      task_id: 'BUG-5',
      release_status: 'waiting_mainline',
      released_at: null,
      release_evidence: JSON.stringify({ mainlineHold: { repo: 'gba_console', sha: 'b'.repeat(40), check: ['npx', 'vitest', 'run'], since: at(80) } }),
    }),
    runRow({ task_id: 'BUG-6', status: 'queued', release_status: 'pending', released_at: null, started_at: null, finished_at: null, created_at: at(10) }),
    runRow({ task_id: 'BUG-8', status: 'failed', error: 'usage limit reached, try again at 13:00', release_status: 'blocked', released_at: null, finished_at: at(30), updated_at: at(30) }),
    runRow({ task_id: 'BUG-9', status: 'needs_review', release_status: 'blocked', released_at: null }),
    runRow({ task_id: 'BUG-10', status: 'blocked', error: 'Зупинено оператором.', release_status: 'blocked', released_at: null }),
    runRow({ task_id: 'BUG-1', created_at: at(60 * 24 * 40), started_at: at(60 * 24 * 40), finished_at: at(60 * 24 * 40), released_at: at(60 * 24 * 40) }),
  ]
  const metrics = computeMetrics({
    tasks,
    runs,
    lastComments: [{ task_id: 'BUG-5', last_comment_at: at(65) }],
    pipelineComments: [{ task_id: 'BUG-5', body: '[конвеєр:waiting-mainline] Реліз чекає', created_at: at(80) }],
    now,
    days: 28,
  })

  assert.equal(metrics.totals.finishedRuns, 5)
  assert.equal(metrics.totals.releasedRuns, 2)
  assert.equal(metrics.totals.releaseRate, 0.4)
  assert.deepEqual(metrics.totals.timeToDeploy, { count: 2, p50: minutes(20), p90: minutes(90) })
  assert.equal(metrics.totals.queueWait.p90, minutes(100))
  assert.equal(metrics.weekly.length, 1)
  assert.equal(metrics.weekly[0].weekStart, '2026-10-19')
  assert.equal(metrics.weekly[0].releaseRate, 0.4)

  const reasons = Object.fromEntries(metrics.failureReasons.map((reason) => [reason.reason, reason.count]))
  assert.equal(reasons.quality_gate, 1)
  assert.equal(reasons.waiting_mainline, 1)
  assert.equal(reasons.codex_usage_limit, 1)
  assert.equal(reasons.stopped, 1)
  assert.equal(reasons.needs_review, 1)

  const kinds = metrics.alerts.map((alert) => `${alert.kind}:${alert.taskId ?? alert.source ?? ''}`)
  assert.ok(kinds.includes('main_red:BUG-7'))
  assert.ok(kinds.includes('main_red:release-hold'))
  assert.ok(kinds.includes('long_run:BUG-4'))
  assert.ok(kinds.includes('stale_task:BUG-4'))
  assert.ok(kinds.includes('stale_task:BUG-5'))
  assert.ok(!kinds.includes('stale_task:BUG-6'))
  assert.ok(!kinds.includes('stale_task:BUG-8'), 'failed run без активного релізу не є «завислою» задачею')
  const hold = metrics.alerts.find((alert) => alert.source === 'release-hold')
  assert.deepEqual(hold.taskIds, ['BUG-5'])
  assert.equal(hold.check, 'npx vitest run')
  const usage = metrics.alerts.find((alert) => alert.kind === 'usage_limit')
  assert.equal(usage.count, 1)
  assert.deepEqual(usage.taskIds, ['BUG-8'])

  assert.equal(metrics.timeline[0].taskId, 'BUG-6')
  const waiting = metrics.timeline.find((entry) => entry.taskId === 'BUG-5')
  assert.equal(waiting.outcome, 'waiting_mainline')
  assert.equal(waiting.stages.waitingMainlineSince, at(80))
  assert.deepEqual(waiting.events.map((event) => event.kind), ['comment:waiting-mainline'])
  const released = metrics.timeline.find((entry) => entry.taskId === 'BUG-2')
  assert.equal(released.durations.deployMs, minutes(90))
  assert.equal(metrics.timeline.find((entry) => entry.taskId === 'BUG-1').runsInWindow, 1)
})

test('GET /api/metrics читає seeded store лише на читання й обмежує період', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-metrics-api-'))
  const store = new TaskStore(path.join(root, 'data'))
  try {
    const app = await createApp({
      rootDirectory: root,
      dataDirectory: path.join(root, 'data'),
      uploadsDirectory: path.join(root, 'uploads'),
      store,
      authRequired: false,
      internalApiToken: 'test-internal-token',
    })
    const created = await request(app).post('/api/tasks').field('title', 'Метрики').expect(201)
    const runId = created.body.agentRun.id
    const claimed = store.claimNextAgentRun('worker-metrics')
    assert.equal(claimed.id, runId)
    store.updateAgentRun(runId, { status: 'completed', finishedAt: new Date().toISOString() })
    store.updateAgentRunRelease(runId, {
      status: 'released',
      phase: 'released',
      releasedAt: new Date(Date.now() + 60_000).toISOString(),
      evidence: { deployment: { verifiedAt: new Date().toISOString(), services: {} }, liveVerification: { passed: true, at: new Date().toISOString() } },
    }, 'ready_for_retest')
    store.addTaskComment('comment-1', created.body.id, { author: 'Система', body: '[конвеєр:released] Випущено', parentId: null })
    const before = JSON.stringify(store.findAgentRun(runId))

    const response = await request(app).get('/api/metrics?days=999').expect(200)
    assert.equal(response.body.days, 180)
    assert.equal(response.body.totals.finishedRuns, 1)
    assert.equal(response.body.totals.releaseRate, 1)
    assert.equal(response.body.timeline[0].taskId, created.body.id)
    assert.equal(response.body.timeline[0].outcome, 'released')
    assert.ok(response.body.timeline[0].stages.verifiedAt)
    assert.deepEqual(response.body.timeline[0].events.map((event) => event.kind), ['comment:released'])
    assert.equal(JSON.stringify(store.findAgentRun(runId)), before)

    const defaults = await request(app).get('/api/metrics').expect(200)
    assert.equal(defaults.body.days, 28)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('пауза worker через ліміт Codex з’являється в сигналах навіть без failed-запусків', async () => {
  const { computeMetrics } = await import('../server/metrics.js')
  const now = Date.parse('2026-10-20T12:00:00.000Z')
  const metrics = computeMetrics({
    usageLimitState: { at: '2026-10-20T11:30:00.000Z', pausedUntil: '2026-10-20T12:15:00.000Z' },
    now,
  })
  const alert = metrics.alerts.find((item) => item.kind === 'usage_limit')
  assert.equal(alert.count, 1)
  assert.equal(alert.pausedUntil, '2026-10-20T12:15:00.000Z')
  const stale = computeMetrics({ usageLimitState: { at: '2026-10-18T11:30:00.000Z', pausedUntil: '2026-10-18T12:00:00.000Z' }, now })
  assert.equal(stale.alerts.some((item) => item.kind === 'usage_limit'), false)
})
