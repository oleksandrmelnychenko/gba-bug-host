import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ReleaseWorker, branchName, defaultRepoPlan, hasWorkNewerThanGate, isMigrationFile, isReleased, isRetryableValidation, isSandboxLimitedReview, isSentinelTask, lastGateAt, parseComposePs, releaseStatusFor, selectReleasableTasks, selectRepositoryChecks, taskSlug, validateReleaseHandoff, validationGateFingerprint } from '../server/release-worker.js'
import { materializeInstalledDependencies } from '../server/worktree-dependencies.js'

function releasePlanDetails(repositories = ['repo'], services = []) {
  return JSON.stringify({
    releasePlan: {
      repositories,
      services,
      migrationFiles: [],
      postDeployChecks: [{
        label: 'task scenario',
        url: 'http://127.0.0.1/task-scenario',
        expectedStatus: 200,
        contains: '',
      }],
    },
  })
}

test('release gate перевідтворює agent-writable dependencies із trusted main', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-release-deps-'))
  const repository = path.join(root, 'main')
  const worktree = path.join(root, 'worktree')
  const trustedRunner = path.join(repository, 'node_modules', '.bin', 'verify')
  const targetRunner = path.join(worktree, 'node_modules', '.bin', 'verify')
  await mkdir(path.dirname(trustedRunner), { recursive: true })
  await mkdir(path.dirname(targetRunner), { recursive: true })
  await writeFile(trustedRunner, 'trusted\n', 'utf8')
  await writeFile(targetRunner, 'agent-tampered\n', 'utf8')
  await writeFile(path.join(worktree, 'node_modules', '.gba-isolated-dependencies-v2'), 'isolated-v2\n', 'utf8')

  try {
    await materializeInstalledDependencies(repository, worktree, { forceRefresh: true })
    assert.equal(await readFile(targetRunner, 'utf8'), 'trusted\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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

test('після релізу закривається лише лог-задача, людський статус лишається людям', () => {
  assert.equal(releaseStatusFor({ notes: '[sentinel:abcdef123456]' }), 'done')
  assert.equal(releaseStatusFor({ title: '[AUTO] console: TypeError' }), 'done')
  assert.equal(releaseStatusFor({ title: 'Кошик губить позицію', notes: '' }), undefined)
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

  assert.deepEqual(selectReleasableTasks(tasks).map((item) => item.id), ['processing', 'retrying', 'pending'])
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

test('детермінована release-помилка блокує pipeline, але не змінює людський статус задачі', async () => {
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
  assert.equal(task.status, 'ready_for_retest')
  assert.match(annotations[0], /release-blocked/)
})

test('застарілий full-stack repo без доказаного коміту не отримує false release', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-release-main-'))
  const worktrees = await mkdtemp(path.join(tmpdir(), 'gba-release-worktrees-'))
  const worktree = path.join(worktrees, 'bug-2089', 'repo')
  await mkdir(worktree, { recursive: true })
  await writeFile(path.join(worktree, '.git'), 'gitdir fixture', 'utf8')
  const worker = new ReleaseWorker({
    worktreesDirectory: worktrees,
    repoPlan: {
      repo: { branch: 'main', root, services: [], checks: [['verify']] },
    },
    processRunner: async (_command, args) => {
      if (args.includes('log')) return { code: 0, output: '' }
      if (args.includes('merge-base')) return { code: 1, output: '' }
      return { code: 0, output: '' }
    },
  })

  try {
    const outcome = await worker.releaseTask({
      id: 'BUG-2089',
      title: 'Console-only fix',
      agentRun: { releaseRepositories: ['repo'] },
    })

    assert.equal(outcome.ok, false)
    assert.equal(outcome.kind, 'repository')
    assert.match(outcome.reason, /жодного реального коміту/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(worktrees, { recursive: true, force: true })
  }
})

test('перевірка нового мерджу виконується у task-worktree і не змінює mainline при падінні', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-release-main-'))
  const worktrees = await mkdtemp(path.join(tmpdir(), 'gba-release-worktrees-'))
  const task = {
    id: 'BUG-2090',
    title: 'Crash-safe validation',
    agentRun: { id: 'RUN-2090', releaseRepositories: [], details: releasePlanDetails() },
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
      if (args.includes('symbolic-ref')) return { code: 0, output: 'main' }
      if (command === 'verify') return { code: 1, output: 'red' }
      if (args.includes('log')) return { code: 0, output: 'c'.repeat(40) }
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
    agentRun: { id: 'RUN-2091', releaseRepositories: [], details: releasePlanDetails() },
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
      if (args.includes('symbolic-ref')) return { code: 0, output: 'main' }
      if (args.includes('log')) return { code: 0, output: 'c'.repeat(40) }
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
    assert.equal(calls[publishIndex].args.at(-1), baseline)
    assert.equal(
      calls.some((call) => call.command === 'git'
        && call.args.includes('push')
        && call.args.includes(`${baseline}:refs/heads/main`)),
      true)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(worktrees, { recursive: true, force: true })
  }
})

test('змінений після validation task ref не може підмінити перевірений commit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-release-main-'))
  const worktrees = await mkdtemp(path.join(tmpdir(), 'gba-release-worktrees-'))
  const worktree = path.join(worktrees, 'bug-2096', 'repo')
  await mkdir(worktree, { recursive: true })
  await writeFile(path.join(worktree, '.git'), 'gitdir fixture', 'utf8')
  const branch = 'codex/qa-bug-2096'
  const baseline = 'b'.repeat(40)
  const validated = 'c'.repeat(40)
  const changed = 'd'.repeat(40)
  const calls = []
  const worker = new ReleaseWorker({
    worktreesDirectory: worktrees,
    repoPlan: { repo: { branch: 'main', root, services: [], checks: [['verify']] } },
    processRunner: async (command, args) => {
      calls.push([command, ...args].join(' '))
      if (args.includes('symbolic-ref')) return { code: 0, output: 'main' }
      if (args.includes('log')) return { code: 0, output: validated }
      if (args.includes('merge-base')) return { code: 1, output: '' }
      if (args.includes('rev-parse') && args.at(-1) === branch) return { code: 0, output: changed }
      if (args.includes('rev-parse') && args.includes(worktree)) return { code: 0, output: validated }
      if (args.includes('rev-parse')) return { code: 0, output: baseline }
      return { code: 0, output: '' }
    },
  })
  worker.updateRelease = async () => {}

  try {
    const outcome = await worker.releaseTask({
      id: 'BUG-2096',
      title: 'Mutable task ref',
      agentRun: { id: 'RUN-2096', details: releasePlanDetails() },
    })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.kind, 'transient')
    assert.match(outcome.reason, /task-гілка змінилася/)
    assert.equal(calls.some((call) => call.includes('merge --ff-only')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(worktrees, { recursive: true, force: true })
  }
})

test('already-merged mainline теж pin-иться на перевірений baseline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-release-main-'))
  const worktrees = await mkdtemp(path.join(tmpdir(), 'gba-release-worktrees-'))
  const worktree = path.join(worktrees, 'bug-2097', 'repo')
  await mkdir(worktree, { recursive: true })
  await writeFile(path.join(worktree, '.git'), 'gitdir fixture', 'utf8')
  const baseline = 'e'.repeat(40)
  const changed = 'f'.repeat(40)
  let headReads = 0
  const calls = []
  const worker = new ReleaseWorker({
    worktreesDirectory: worktrees,
    repoPlan: { repo: { branch: 'main', root, services: [], checks: [['verify']] } },
    processRunner: async (command, args) => {
      calls.push([command, ...args].join(' '))
      if (args.includes('symbolic-ref')) return { code: 0, output: 'main' }
      if (args.includes('log')) return { code: 0, output: '' }
      if (args.includes('--is-ancestor')) return { code: 0, output: '' }
      if (args.includes('rev-parse')) {
        headReads += 1
        return { code: 0, output: headReads === 1 ? baseline : changed }
      }
      return { code: 0, output: '' }
    },
  })
  worker.updateRelease = async () => {}

  try {
    const outcome = await worker.releaseTask({
      id: 'BUG-2097',
      title: 'Already merged baseline race',
      agentRun: {
        id: 'RUN-2097',
        releaseRepositories: ['repo'],
        details: releasePlanDetails(),
        releaseEvidence: { repositories: { repo: { files: [] } } },
      },
    })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.kind, 'transient')
    assert.match(outcome.reason, /mainline змінився/)
    assert.equal(calls.some((call) => call.includes('push origin')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(worktrees, { recursive: true, force: true })
  }
})

test('одноразовий флейк перевірки повторюється і не блокує release', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-release-main-'))
  const worktrees = await mkdtemp(path.join(tmpdir(), 'gba-release-worktrees-'))
  const worktree = path.join(worktrees, 'bug-2092', 'repo')
  await mkdir(worktree, { recursive: true })
  await writeFile(path.join(worktree, '.git'), 'gitdir fixture', 'utf8')
  const task = {
    id: 'BUG-2092',
    title: 'Flaky validation',
    agentRun: { id: 'RUN-2092', releaseRepositories: [], details: releasePlanDetails() },
  }
  const baseline = 'd'.repeat(40)
  let validationAttempts = 0
  const worker = new ReleaseWorker({
    worktreesDirectory: worktrees,
    repoPlan: {
      repo: {
        branch: 'main',
        root,
        services: [],
        checks: [['dotnet', 'test', 'suite.csproj']],
      },
    },
    processRunner: async (command, args) => {
      if (args.includes('symbolic-ref')) return { code: 0, output: 'main' }
      if (command === 'dotnet') {
        validationAttempts += 1
        return validationAttempts === 1
          ? { code: 1, output: 'timing flake' }
          : { code: 0, output: 'green retry' }
      }
      if (args.includes('log')) return { code: 0, output: 'e'.repeat(40) }
      if (args.includes('rev-parse')) return { code: 0, output: baseline }
      if (args.includes('merge-base')) return { code: 1, output: '' }
      return { code: 0, output: '' }
    },
  })
  worker.updateRelease = async () => {}

  try {
    const outcome = await worker.releaseTask(task)

    assert.equal(outcome.ok, true)
    assert.equal(validationAttempts, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(worktrees, { recursive: true, force: true })
  }
})

test('build-помилка не запускає повну команду вдруге, retry дозволений лише відомим test-flake', () => {
  assert.equal(isRetryableValidation(['npm', 'run', 'build'], { output: 'timing flake' }), false)
  assert.equal(isRetryableValidation(['dotnet', 'test', 'suite.csproj'], { output: 'compile error' }), false)
  assert.equal(isRetryableValidation(['dotnet', 'test', 'suite.csproj'], { output: 'ConsumerTimeout_ReleasesLease failed' }), true)
})

test('server release запускає тільки тести відомого зміненого контуру, невідомий source fail-closed бере всі', () => {
  const plan = defaultRepoPlan['gba-server']
  const names = (files) => selectRepositoryChecks(plan, files).map((check) => check.join(' '))
  const api = names(['src/Global.Business.Assistant.Api/Controllers/SalesController.cs'])
  assert.equal(api.some((name) => name.includes('Api.Tests')), true)
  assert.equal(api.some((name) => name.includes('Platform.Actors.Tests')), false)
  assert.equal(api.some((name) => name.includes('Domain.Tests')), false)

  const application = names(['src/Global.Business.Assistant.Application/Sales/SaleService.cs'])
  assert.equal(application.some((name) => name.includes('Api.Tests')), true)
  assert.equal(application.some((name) => name.includes('Platform.Actors.Tests')), false)

  const actor = names(['src/Global.Business.Assistant.Supply.Actors/SupplyActor.cs'])
  assert.equal(actor.some((name) => name.includes('Platform.Actors.Tests')), true)
  assert.equal(actor.some((name) => name.includes('Domain.Tests')), false)

  const unknown = names(['src/Global.Business.Assistant.SharedKernel/Money.cs'])
  assert.equal(unknown.filter((name) => name.includes(' test ')).length, 3)
})

test('release handoff звіряє repo/services/migrations і дозволяє лише безпечний DEV GET', () => {
  const migration = 'src/Global.Business.Assistant.Database/Migrations/20260813_AddProof.cs'
  assert.equal(isMigrationFile('gba-server', migration), true)
  const evidence = { 'gba-server': { files: [migration] } }
  const valid = validateReleaseHandoff({
    repositories: ['gba-server'],
    services: ['data-concord', 'data-analytics'],
    migrationFiles: [`gba-server:${migration}`],
    postDeployChecks: [{
      label: 'sales page',
      url: 'https://gba-console-dev.85.17.167.167.nip.io/sales/ukraine/all',
      expectedStatus: 200,
      contains: '',
    }],
  }, ['gba-server'], ['data-concord', 'data-analytics'], evidence, defaultRepoPlan)
  assert.equal(valid.ok, true)
  assert.equal(valid.legacy, false)
  assert.deepEqual(valid.declaredServices, ['data-concord', 'data-analytics'])
  assert.deepEqual(valid.effectiveServices, ['data-concord', 'data-analytics'])
  assert.deepEqual(valid.autoAddedServices, [])

  const incompleteServices = validateReleaseHandoff({
    repositories: ['gba-server'],
    services: ['data-concord'],
    migrationFiles: [`gba-server:${migration}`],
    postDeployChecks: valid.checks,
  }, ['gba-server'], ['data-concord', 'data-analytics'], evidence, defaultRepoPlan)
  assert.equal(incompleteServices.ok, true)
  assert.deepEqual(incompleteServices.declaredServices, ['data-concord'])
  assert.deepEqual(incompleteServices.effectiveServices, ['data-concord', 'data-analytics'])
  assert.deepEqual(incompleteServices.autoAddedServices, ['data-analytics'])

  const emptyServices = validateReleaseHandoff({
    repositories: ['gba-server'],
    services: [],
    migrationFiles: [`gba-server:${migration}`],
    postDeployChecks: valid.checks,
  }, ['gba-server'], ['data-concord', 'data-analytics'], evidence, defaultRepoPlan)
  assert.equal(emptyServices.ok, true)
  assert.deepEqual(emptyServices.autoAddedServices, ['data-concord', 'data-analytics'])

  const unexpectedService = validateReleaseHandoff({
    repositories: ['gba-server'],
    services: ['data-concord', 'gba-console'],
    migrationFiles: [`gba-server:${migration}`],
    postDeployChecks: valid.checks,
  }, ['gba-server'], ['data-concord', 'data-analytics'], evidence, defaultRepoPlan)
  assert.equal(unexpectedService.ok, false)
  assert.match(unexpectedService.reason, /поза repo plan/)

  const missing = validateReleaseHandoff({}, ['gba-server'], ['data-concord'], evidence, defaultRepoPlan)
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /releasePlan/)

  const missingMigration = validateReleaseHandoff({
    repositories: ['gba-server'],
    services: ['data-concord', 'data-analytics'],
    migrationFiles: [],
    postDeployChecks: valid.checks,
  }, ['gba-server'], ['data-concord', 'data-analytics'], evidence, defaultRepoPlan)
  assert.equal(missingMigration.ok, false)
  assert.match(missingMigration.reason, /migrationFiles/)

  const external = validateReleaseHandoff({
    repositories: ['gba-server'],
    services: ['data-concord', 'data-analytics'],
    migrationFiles: [`gba-server:${migration}`],
    postDeployChecks: [{ label: 'bad', url: 'https://example.com', expectedStatus: 200, contains: '' }],
  }, ['gba-server'], ['data-concord', 'data-analytics'], evidence, defaultRepoPlan)
  assert.equal(external.ok, false)
  assert.match(external.reason, /allowlist/)
})

test('невалідний release handoff зупиняє задачу до тестів і merge', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-release-main-'))
  const worktrees = await mkdtemp(path.join(tmpdir(), 'gba-release-worktrees-'))
  const worktree = path.join(worktrees, 'bug-2095', 'repo')
  await mkdir(worktree, { recursive: true })
  await writeFile(path.join(worktree, '.git'), 'gitdir fixture', 'utf8')
  const calls = []
  const worker = new ReleaseWorker({
    worktreesDirectory: worktrees,
    repoPlan: { repo: { branch: 'main', root, services: [], checks: [['verify']] } },
    processRunner: async (command, args) => {
      calls.push([command, ...args].join(' '))
      if (args.includes('log')) return { code: 0, output: 'a'.repeat(40) }
      if (args.includes('merge-base')) return { code: 1, output: '' }
      return { code: 0, output: '' }
    },
  })
  worker.updateRelease = async () => {}
  const task = {
    id: 'BUG-2095',
    title: 'Bad handoff',
    agentRun: {
      id: 'RUN-2095',
      details: JSON.stringify({
        releasePlan: {
          repositories: ['wrong-repo'],
          services: [],
          migrationFiles: [],
          postDeployChecks: [{
            label: 'health', url: 'http://127.0.0.1/health', expectedStatus: 200, contains: '',
          }],
        },
      }),
    },
  }

  try {
    const outcome = await worker.releaseTask(task)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.phase, 'preflight')
    assert.match(outcome.reason, /repositories/)
    assert.equal(calls.some((call) => call.startsWith('verify ')), false)
    assert.equal(calls.some((call) => call.includes('--ff-only')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(worktrees, { recursive: true, force: true })
  }
})

test('healthy старий image без published git SHA не проходить deployment proof', async () => {
  const imageId = `sha256:${'1'.repeat(64)}`
  const worker = new ReleaseWorker({
    probes: { service: 'http://127.0.0.1/health' },
    processRunner: async (command, args) => {
      if (command === 'docker' && args[0] === 'inspect') return { code: 0, output: imageId }
      if (command === 'docker' && args[0] === 'image') return { code: 0, output: JSON.stringify({ 'gba.git.sha': 'old-commit' }) }
      return { code: 0, output: '' }
    },
  })
  worker.captureDeployment = async () => ({
    service: {
      Service: 'service', ID: 'container', State: 'running', Health: 'healthy', Image: 'service:latest',
      Labels: 'com.docker.compose.image=sha256:old,gba.git.sha=old-commit',
    },
  })
  const result = await worker.verifyDeployment(['service'], {}, { service: 'new-commit' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /не збігається/)
})

test('HTML live-check звіряє текст без хибного падіння через регістр', async () => {
  const worker = new ReleaseWorker({
    processRunner: async (command, args) => {
      assert.equal(command, 'curl')
      assert.equal(args.includes('-w'), true)
      return { code: 0, output: '<title>GBA CONSOLE</title>\n200' }
    },
  })

  const result = await worker.verifyPostDeployChecks([{
    label: 'console products',
    url: 'https://gba-console-dev.85.17.167.167.nip.io/products',
    expectedStatus: 200,
    contains: 'GBA Console',
  }])

  assert.equal(result.ok, true)
  assert.equal(result.evidence[0].passed, true)
})

test('успішна validation того самого commit повторно не запускає батарею після deploy-retry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-release-main-'))
  const worktrees = await mkdtemp(path.join(tmpdir(), 'gba-release-worktrees-'))
  const worktree = path.join(worktrees, 'bug-2094', 'repo')
  await mkdir(worktree, { recursive: true })
  await writeFile(path.join(worktree, '.git'), 'gitdir fixture', 'utf8')
  const commit = 'f'.repeat(40)
  let validations = 0
  const task = {
    id: 'BUG-2094',
    title: 'Resume after deploy',
    agentRun: {
      id: 'RUN-2094',
      releaseRepositories: ['repo'],
      details: releasePlanDetails(['repo'], ['service']),
      releaseEvidence: {
        repositories: {
          repo: {
            validatedCommit: commit,
            validation: 'passed',
            files: [],
            gateFingerprint: validationGateFingerprint('repo', commit, [], [['verify']]),
          },
        },
      },
    },
  }
  const worker = new ReleaseWorker({
    worktreesDirectory: worktrees,
    repoPlan: { repo: { branch: 'main', root, services: ['service'], checks: [['verify']] } },
    processRunner: async (command, args) => {
      if (args.includes('symbolic-ref')) return { code: 0, output: 'main' }
      if (command === 'verify') {
        validations += 1
        return { code: 0, output: '' }
      }
      if (args.includes('log')) return { code: 0, output: '' }
      if (args.includes('--is-ancestor')) return { code: 0, output: '' }
      if (args.includes('rev-parse')) return { code: 0, output: commit }
      return { code: 0, output: '' }
    },
  })
  worker.updateRelease = async () => {}

  try {
    const outcome = await worker.releaseTask(task)
    assert.equal(outcome.ok, true)
    assert.equal(validations, 0)
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
      details: releasePlanDetails(['repo'], ['service']),
    },
  }
  const repoPlan = { repo: { branch: 'main', root: '/repo', services: ['service'], checks: [] } }
  const annotations = []
  const updateRelease = async (item, values) => {
    item.agentRun.releaseStatus = values.status
    if (values.attempts !== undefined) item.agentRun.releaseAttempts = values.attempts
    if (values.phase !== undefined) item.agentRun.releasePhase = values.phase
    if (values.evidence !== undefined) item.agentRun.releaseEvidence = values.evidence
    if (values.taskStatus) item.status = values.taskStatus
  }
  const failed = new ReleaseWorker({
    repoPlan,
    processRunner: async () => ({ code: 1, output: 'compose failed' }),
  })
  failed.releaseTask = async () => ({ ok: true, repos: ['repo'] })
  failed.verifyPublishedWorktrees = async () => ({ ok: true })
  failed.updateRelease = updateRelease
  failed.annotate = async (_item, line) => annotations.push(line)

  await failed.releaseBatch([task])
  assert.equal(task.agentRun.releaseStatus, 'retrying')
  assert.equal(task.agentRun.releaseAttempts, 1)
  assert.match(annotations.at(-1), /release-retry.*deploying/)

  let deployed = false
  const calls = []
  const successfulPlan = {
    repo: {
      ...repoPlan.repo,
      migration: { command: 'migrate', args: ['apply'], timeoutMs: 60_000 },
    },
  }
  const succeeded = new ReleaseWorker({
    repoPlan: successfulPlan,
    probes: { service: 'http://service/health' },
    processRunner: async (command, args) => {
      calls.push([command, ...args].join(' '))
      if (command === 'docker' && args.includes('ps')) {
        return {
          code: 0,
          output: JSON.stringify({
            Service: 'service',
            ID: deployed ? 'new-container' : 'old-container',
            State: 'running',
            Health: 'healthy',
            Image: 'service:latest',
            Labels: 'com.docker.compose.image=sha256:new-image,gba.git.sha=abc',
          }),
        }
      }
      if (command === 'docker' && args[0] === 'inspect') return { code: 0, output: `sha256:${'2'.repeat(64)}` }
      if (command === 'docker' && args[0] === 'image') {
        return { code: 0, output: JSON.stringify({ 'gba.git.sha': deployed ? 'abc' : 'old' }) }
      }
      if (command === 'docker' && args.includes('up')) deployed = true
      if (command === 'curl' && args.includes('-w')) return { code: 0, output: 'ok\n200' }
      return { code: 0, output: 'ok' }
    },
  })
  succeeded.releaseTask = async () => ({
    ok: true,
    repos: ['repo'],
    alreadyMerged: false,
    repositoryEvidence: { repo: { commit: 'abc', pushed: true } },
  })
  succeeded.verifyPublishedWorktrees = async () => ({ ok: true })
  succeeded.updateRelease = updateRelease
  succeeded.annotate = async (_item, line) => annotations.push(line)
  succeeded.cleanupReleasedWorktrees = async () => []

  await succeeded.releaseBatch([task])
  assert.equal(task.agentRun.releaseStatus, 'released')
  assert.equal(task.agentRun.releasePhase, 'released')
  assert.equal(task.status, 'ready_for_retest')
  const deployCallIndex = calls.findIndex((call) => call.includes(' up '))
  assert.ok(calls.findIndex((call) => call.startsWith('migrate apply')) < deployCallIndex)
  assert.ok(calls.findIndex((call, index) => index > deployCallIndex && call.startsWith('curl ')) > deployCallIndex)
  assert.ok(calls[deployCallIndex].includes(' --no-deps '))
})

test('retry з уже точним healthy image не пересоздає контейнер повторно', async () => {
  const task = {
    id: 'BUG-2098',
    title: 'Scenario retry without downtime',
    status: 'in_progress',
    notes: '',
    agentRun: {
      id: 'RUN-2098',
      releaseAttempts: 9,
      releaseRepositories: ['repo'],
      releaseStatus: 'retrying',
      details: releasePlanDetails(['repo'], ['service']),
    },
  }
  const calls = []
  const worker = new ReleaseWorker({
    repoPlan: { repo: { branch: 'main', root: '/repo', services: ['service'], checks: [] } },
    processRunner: async (command, args) => {
      calls.push([command, ...args].join(' '))
      return { code: 0, output: '' }
    },
  })
  worker.releaseTask = async () => ({
    ok: true,
    repos: ['repo'],
    alreadyMerged: true,
    repositoryEvidence: { repo: { commit: 'abc', pushed: true } },
  })
  worker.verifyPublishedWorktrees = async () => ({ ok: true })
  worker.captureDeployment = async () => ({
    service: { ID: 'current-container', State: 'running', Health: 'healthy' },
  })
  worker.verifyDeployment = async () => ({
    ok: true,
    services: {
      service: {
        containerId: 'current-container',
        imageCommit: 'abc',
        replaced: false,
        state: 'running',
        health: 'healthy',
      },
    },
  })
  worker.verifyPostDeployChecks = async () => ({ ok: true, evidence: [] })
  worker.cleanupReleasedWorktrees = async () => []
  worker.annotate = async () => {}
  worker.updateRelease = async (item, values) => {
    item.agentRun.releaseStatus = values.status
    if (values.phase !== undefined) item.agentRun.releasePhase = values.phase
    if (values.taskStatus) item.status = values.taskStatus
  }

  await worker.releaseBatch([task])

  assert.equal(task.agentRun.releaseStatus, 'released')
  assert.equal(task.status, 'in_progress')
  assert.equal(calls.some((call) => call.includes(' compose ') && call.includes(' up ')), false)
})

test('compose ps parser підтримує JSON array та JSON-lines', () => {
  assert.equal(parseComposePs('[{"Service":"a"}]')[0].Service, 'a')
  assert.deepEqual(parseComposePs('{"Service":"a"}\n{"Service":"b"}').map((item) => item.Service), ['a', 'b'])
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

test('release-тести frontend обмежують кількість Vitest workers', () => {
  for (const repo of ['gba_console', 'gba_ecommerce']) {
    const vitest = defaultRepoPlan[repo].checks.find((check) => check.includes('vitest'))
    assert.ok(vitest, repo)
    assert.equal(vitest.includes('--maxWorkers=8'), true, repo)
  }
})
