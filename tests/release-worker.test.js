import assert from 'node:assert/strict'
import test from 'node:test'
import { branchName, isReleased, selectReleasableTasks, taskSlug } from '../server/release-worker.js'

test('слаг і назва гілки збігаються з worker-конвенцією', () => {
  assert.equal(taskSlug('BUG-1024'), 'bug-1024')
  assert.equal(branchName('BUG-1024'), 'codex/qa-bug-1024')
})

test('released-маркер розпізнається', () => {
  assert.equal(isReleased({ notes: 'щось\n[released:2026-08-06 22:10] змерджено' }), true)
  assert.equal(isReleased({ notes: '[sentinel:abcdef123456]' }), false)
  assert.equal(isReleased({}), false)
})

test('відбираються лише completed без released і не done', () => {
  const tasks = [
    { id: 'A', status: 'ready_for_retest', notes: '', agentRun: { status: 'completed' } },
    { id: 'B', status: 'ready_for_retest', notes: '[released:x]', agentRun: { status: 'completed' } },
    { id: 'C', status: 'ready_for_retest', notes: '', agentRun: { status: 'needs_review' } },
    { id: 'D', status: 'done', notes: '', agentRun: { status: 'completed' } },
    { id: 'E', status: 'in_progress', notes: '', agentRun: { status: 'running' } },
  ]
  assert.deepEqual(selectReleasableTasks(tasks).map((task) => task.id), ['A'])
})
