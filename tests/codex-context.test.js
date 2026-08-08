import assert from 'node:assert/strict'
import test from 'node:test'
import {
  codexSessionIdFromEventLine,
  composePersistentContext,
  createCodexSessionTracker,
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
