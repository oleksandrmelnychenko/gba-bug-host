import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ReleaseWorker, branchName, defaultRepoPlan, hasWorkNewerThanGate, isReleased, isSandboxLimitedReview, isSentinelTask, lastGateAt, releaseStatusFor, selectReleasableTasks, taskSlug } from '../server/release-worker.js'

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

test('лог-задача вартового впізнається за маркером і за заголовком', () => {
  assert.equal(isSentinelTask({ notes: '[sentinel:abcdef123456] build:x' }), true)
  assert.equal(isSentinelTask({ title: '[AUTO] gba-ecommerce-api: NullReferenceException' }), true)
  assert.equal(isSentinelTask({ notes: '[released:2026-08-07 01:00]', title: 'Пошук падає' }), false)
  assert.equal(isSentinelTask({}), false)
})

test('після релізу лог-задача закривається, людська йде на ретест', () => {
  assert.equal(releaseStatusFor({ notes: '[sentinel:abcdef123456]' }), 'done')
  assert.equal(releaseStatusFor({ title: '[AUTO] console: TypeError' }), 'done')
  assert.equal(releaseStatusFor({ title: 'Кошик губить позицію', notes: '' }), 'ready_for_retest')
})

test('нова робота після релізу знову потрапляє у вибірку', () => {
  const released = { id: 'A', status: 'ready_for_retest', notes: '[released:2026-08-07 00:20] змерджено' }
  const stale = { ...released, agentRun: { status: 'completed', finishedAt: '2026-08-06T23:00:00.000Z' } }
  const fresh = { ...released, agentRun: { status: 'completed', finishedAt: '2026-08-07T08:24:15.000Z' } }

  assert.equal(selectReleasableTasks([stale]).length, 0, 'старий прогін не перевипускаємо')
  assert.equal(selectReleasableTasks([fresh]).length, 1, 'друга спроба Codex має доїхати в мейнлайн')
})

test('заблокована задача чекає нового прогону, а не ретраїться вічно', () => {
  const blocked = { id: 'B', status: 'blocked', notes: '[release-blocked:2026-08-07 11:54] конфлікт мерджу' }

  assert.equal(hasWorkNewerThanGate({ ...blocked, agentRun: { finishedAt: '2026-08-07T10:00:00.000Z' } }), false)
  assert.equal(hasWorkNewerThanGate({ ...blocked, agentRun: { finishedAt: '2026-08-07T12:30:00.000Z' } }), true)
})

test('останній із кількох релізів визначає межу', () => {
  const task = {
    notes: '[released:2026-08-05 10:00] перший\n[released:2026-08-07 09:00] другий',
    agentRun: { status: 'completed', finishedAt: '2026-08-06T12:00:00.000Z' },
  }
  // Мітка з точністю до хвилини діє до кінця цієї хвилини, інакше прогін,
  // що завершився на :30 тієї ж хвилини, випускався б удруге.
  assert.equal(lastGateAt(task), Date.parse('2026-08-07T09:00:59.999Z'))
  assert.equal(hasWorkNewerThanGate(task), false)
})

test('задача без жодної мітки випускається як і раніше', () => {
  const task = { id: 'C', status: 'ready_for_retest', notes: '', agentRun: { status: 'completed', finishedAt: '2026-08-07T08:00:00.000Z' } }
  assert.equal(isReleased(task), false)
  assert.deepEqual(selectReleasableTasks([task]).map((item) => item.id), ['C'])
})

test('структурований release-state відновлює pending/retrying і не перевипускає released/blocked', () => {
  const task = (id, releaseStatus) => ({
    id,
    status: 'ready_for_retest',
    notes: '[released:2026-08-01 10:00] старий прогін',
    agentRun: {
      status: 'completed',
      finishedAt: '2026-08-07T10:00:00.000Z',
      releaseStatus,
    },
  })
  const tasks = [
    task('pending', 'pending'),
    task('processing', 'processing'),
    task('retrying', 'retrying'),
    task('released', 'released'),
    task('blocked', 'blocked'),
  ]

  assert.deepEqual(selectReleasableTasks(tasks).map((item) => item.id), ['pending', 'processing', 'retrying'])
})

test('settle одного нового кандидата не блокує вже готові задачі', async () => {
  const originalFetch = global.fetch
  const tasks = ['ready', 'new'].map((id) => ({
    id,
    status: 'ready_for_retest',
    notes: '',
    agentRun: { status: 'completed', releaseStatus: 'pending' },
  }))
  const released = []
  const worker = new ReleaseWorker({ settleMs: 100 })
  worker.firstSeenAt.set('ready', Date.now() - 1_000)
  worker.releaseBatch = async (batch) => released.push(...batch.map((task) => task.id))
  global.fetch = async () => ({ ok: true, json: async () => tasks })

  try {
    await worker.tick()
    assert.deepEqual(released, ['ready'])
    assert.equal(worker.firstSeenAt.has('new'), true)
  } finally {
    global.fetch = originalFetch
  }
})

test('детермінована release-помилка блокується після третьої збереженої спроби', async () => {
  const task = {
    id: 'BUG-2001',
    title: 'Конфлікт',
    status: 'ready_for_retest',
    notes: '',
    agentRun: { id: 'RUN-2001', releaseAttempts: 2 },
  }
  const annotations = []
  const worker = new ReleaseWorker()
  worker.releaseTask = async () => ({ ok: false, kind: 'validation', reason: 'тести впали' })
  worker.updateRelease = async (item, values) => {
    item.agentRun.releaseStatus = values.status
    item.agentRun.releaseAttempts = values.attempts
    if (values.taskStatus) item.status = values.taskStatus
  }
  worker.annotate = async (_item, line) => annotations.push(line)

  await worker.releaseBatch([task])

  assert.equal(task.agentRun.releaseStatus, 'blocked')
  assert.equal(task.agentRun.releaseAttempts, 3)
  assert.equal(task.status, 'blocked')
  assert.match(annotations[0], /release-blocked/)
})

test('перевірка нового мерджу виконується у task-worktree і не змінює mainline при падінні', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-release-main-'))
  const worktrees = await mkdtemp(path.join(tmpdir(), 'gba-release-worktrees-'))
  const task = {
    id: 'BUG-2090',
    title: 'Crash-safe validation',
    agentRun: { id: 'RUN-2090', releaseRepositories: [] },
  }
  const worktree = path.join(worktrees, 'bug-2090', 'repo')
  await mkdir(worktree, { recursive: true })
  await writeFile(path.join(worktree, '.git'), 'gitdir fixture', 'utf8')
  const calls = []
  const baseline = 'a'.repeat(40)
  const worker = new ReleaseWorker({
    worktreesDirectory: worktrees,
    repoPlan: {
      repo: {
        branch: 'main',
        root,
        services: [],
        checks: [['verify', 'candidate']],
      },
    },
    processRunner: async (command, args, options = {}) => {
      calls.push({ command, args, cwd: options.cwd })
      if (command === 'verify') return { code: 1, output: 'red' }
      if (args.includes('rev-list')) return { code: 0, output: '1' }
      if (args.includes('rev-parse')) return { code: 0, output: baseline }
      if (args.includes('merge-base')) return { code: 1, output: '' }
      return { code: 0, output: '' }
    },
  })
  worker.updateRelease = async () => {}

  try {
    const outcome = await worker.releaseTask(task)

    assert.equal(outcome.ok, false)
    assert.equal(outcome.kind, 'validation')
    assert.equal(
      calls.find((call) => call.command === 'verify')?.cwd,
      worktree)
    assert.equal(
      calls.some((call) => call.args.includes('--ff-only')),
      false,
      'mainline не можна рухати до зелених тестів')
    assert.equal(
      calls.some((call) => call.args.includes('reset')),
      false,
      'після падіння немає що відкочувати у mainline')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(worktrees, { recursive: true, force: true })
  }
})

test('зелений кандидат fast-forward-иться у mainline лише після перевірки незмінного baseline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-release-main-'))
  const worktrees = await mkdtemp(path.join(tmpdir(), 'gba-release-worktrees-'))
  const task = {
    id: 'BUG-2091',
    title: 'Validated publish',
    agentRun: { id: 'RUN-2091', releaseRepositories: [] },
  }
  const worktree = path.join(worktrees, 'bug-2091', 'repo')
  await mkdir(worktree, { recursive: true })
  await writeFile(path.join(worktree, '.git'), 'gitdir fixture', 'utf8')
  const calls = []
  const baseline = 'b'.repeat(40)
  const worker = new ReleaseWorker({
    worktreesDirectory: worktrees,
    repoPlan: {
      repo: {
        branch: 'main',
        root,
        services: [],
        checks: [['verify', 'candidate']],
      },
    },
    processRunner: async (command, args, options = {}) => {
      calls.push({ command, args, cwd: options.cwd })
      if (args.includes('rev-list')) return { code: 0, output: '1' }
      if (args.includes('rev-parse')) return { code: 0, output: baseline }
      if (args.includes('merge-base')) return { code: 1, output: '' }
      return { code: 0, output: '' }
    },
  })
  worker.updateRelease = async () => {}

  try {
    const outcome = await worker.releaseTask(task)
    const checkIndex = calls.findIndex((call) => call.command === 'verify')
    const publishIndex = calls.findIndex((call) => call.args.includes('--ff-only'))

    assert.equal(outcome.ok, true)
    assert.ok(checkIndex >= 0)
    assert.ok(publishIndex > checkIndex)
    assert.equal(calls[checkIndex].cwd, worktree)
    assert.equal(calls[publishIndex].args.at(-1), 'codex/qa-bug-2091')
    assert.equal(
      calls.some((call) => call.command === 'git' && call.args.includes('push')),
      true)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(worktrees, { recursive: true, force: true })
  }
})

test('deploy failure лишає задачу retrying, а наступний успіх завершує release', async () => {
  const task = {
    id: 'BUG-2002',
    title: 'Retry deploy',
    status: 'ready_for_retest',
    notes: '',
    agentRun: {
      id: 'RUN-2002',
      releaseAttempts: 0,
      releaseRepositories: ['repo'],
    },
  }
  const repoPlan = { repo: { branch: 'main', root: '/repo', services: ['service'], checks: [] } }
  const annotations = []
  const updateRelease = async (item, values) => {
    item.agentRun.releaseStatus = values.status
    if (values.attempts !== undefined) item.agentRun.releaseAttempts = values.attempts
    if (values.taskStatus) item.status = values.taskStatus
  }
  const failed = new ReleaseWorker({
    repoPlan,
    processRunner: async () => ({ code: 1, output: 'compose failed' }),
  })
  failed.releaseTask = async () => ({ ok: true, repos: ['repo'] })
  failed.updateRelease = updateRelease
  failed.annotate = async (_item, line) => annotations.push(line)

  await failed.releaseBatch([task])
  assert.equal(task.agentRun.releaseStatus, 'retrying')
  assert.equal(task.agentRun.releaseAttempts, 1)
  assert.match(annotations.at(-1), /автоматична повторна спроба/)

  const succeeded = new ReleaseWorker({
    repoPlan,
    processRunner: async () => ({ code: 0, output: '' }),
  })
  succeeded.releaseTask = async () => ({ ok: true, repos: ['repo'] })
  succeeded.updateRelease = updateRelease
  succeeded.annotate = async (_item, line) => annotations.push(line)
  succeeded.cleanupReleasedWorktrees = async () => []

  await succeeded.releaseBatch([task])
  assert.equal(task.agentRun.releaseStatus, 'released')
  assert.equal(task.status, 'ready_for_retest')
})

test('після release прибираються worktree і вже влита локальна гілка', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-release-cleanup-'))
  const job = path.join(root, 'bug-2003', 'repo')
  await mkdir(job, { recursive: true })
  await writeFile(path.join(job, '.git'), 'gitdir fixture', 'utf8')
  const calls = []
  const worker = new ReleaseWorker({
    worktreesDirectory: root,
    repoPlan: { repo: { branch: 'main', root: '/repo', services: [], checks: [] } },
    processRunner: async (command, args) => {
      calls.push([command, ...args].join(' '))
      return { code: 0, output: '' }
    },
  })

  try {
    assert.deepEqual(await worker.cleanupReleasedWorktrees({ id: 'BUG-2003' }), [])
    assert.equal(calls.some((call) => call.includes('worktree remove --force')), true)
    assert.equal(calls.some((call) => call.includes('branch -D codex/qa-bug-2003')), true)
    await assert.rejects(access(path.join(root, 'bug-2003')), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
