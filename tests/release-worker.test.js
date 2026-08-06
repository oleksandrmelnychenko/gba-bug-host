import assert from 'node:assert/strict'
import test from 'node:test'
import { branchName, defaultRepoPlan, isReleased, isSandboxLimitedReview, selectReleasableTasks, taskSlug } from '../server/release-worker.js'

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

test('needs_review через обмеження пісочниці не паркує задачу', () => {
  const sandboxCases = [
    'sandbox забороняє VSTest відкрити loopback TCP-сокет',
    'у середовищі відсутній .NET SDK і готові test artifacts',
    'bwrap: No permissions to create a new namespace',
    'пісочниця не дала запустити testhost',
  ]
  for (const summary of sandboxCases) {
    assert.equal(isSandboxLimitedReview({ agentRun: { status: 'needs_review', summary } }), true, summary)
  }
})

test('змістовний needs_review далі чекає людину', () => {
  const task = { agentRun: { status: 'needs_review', summary: 'Потрібне рішення бізнесу щодо прав на розблокування продажу.' } }
  assert.equal(isSandboxLimitedReview(task), false)
  assert.equal(selectReleasableTasks([{ id: 'X', status: 'ready_for_retest', notes: '', ...task }]).length, 0)
})

test('sandbox-вердикт потрапляє у вибірку релізу', () => {
  const tasks = [
    { id: 'S', status: 'in_progress', notes: '', agentRun: { status: 'needs_review', summary: 'sandbox блокує dotnet test' } },
    { id: 'T', status: 'done', notes: '', agentRun: { status: 'needs_review', summary: 'sandbox блокує dotnet test' } },
  ]
  assert.deepEqual(selectReleasableTasks(tasks).map((task) => task.id), ['S'])
})

test('план покриває всі сервіси, що збираються з цих репозиторіїв', () => {
  const expected = {
    gba_console: ['gba-console'],
    'gba-server': ['data-concord', 'data-analytics'],
    gba_ecommerce: ['gba-ecommerce'],
    'gba-ecommerce-api': ['gba-ecommerce-api'],
  }
  for (const [repo, services] of Object.entries(expected)) {
    assert.deepEqual(defaultRepoPlan[repo].services, services, repo)
  }
})
