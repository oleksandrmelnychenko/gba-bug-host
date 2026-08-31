import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  CodexWorker,
  codexRetryableInfrastructureFailureKind,
  codexExecutionFailureReason,
  collectWorktreeChanges,
  fixedResultQualityFailures,
  isMissingCodexSessionFailure,
  normalizeCodexReasoningEffort,
  normalizeWorkerConcurrency,
  terminateProcessTree,
} from '../server/codex-worker.js'
import { TaskStore, getSeedTasks } from '../server/store.js'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Очікування умови перевищило таймаут.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('Codex worker примусово нормалізує будь-яку конфігурацію до одного агента', () => {
  assert.equal(normalizeWorkerConcurrency(undefined), 1)
  assert.equal(normalizeWorkerConcurrency('1'), 1)
  assert.equal(normalizeWorkerConcurrency('2'), 1)
  assert.equal(normalizeWorkerConcurrency('3'), 1)
  assert.equal(normalizeWorkerConcurrency('20'), 1)
  assert.equal(normalizeWorkerConcurrency('invalid'), 1)
})

test('Codex worker використовує лише явний підтримуваний reasoning effort', () => {
  assert.equal(normalizeCodexReasoningEffort(' HIGH '), 'high')
  assert.equal(normalizeCodexReasoningEffort('xhigh'), 'xhigh')
  assert.equal(normalizeCodexReasoningEffort('max'), 'max')
  assert.throws(
    () => normalizeCodexReasoningEffort(''),
    /CODEX_REASONING_EFFORT/,
  )
  assert.throws(
    () => normalizeCodexReasoningEffort('unbounded'),
    /CODEX_REASONING_EFFORT/,
  )
})

test('Codex worker розпізнає лише retryable втрату сесії', () => {
  assert.equal(isMissingCodexSessionFailure({ code: 1, stderr: 'thread 123 not found', stdout: '' }), true)
  assert.equal(isMissingCodexSessionFailure({ code: 1, stderr: '', stdout: 'No rollout found for session' }), true)
  assert.equal(isMissingCodexSessionFailure({ code: 1, stderr: 'tests failed', stdout: '' }), false)
  assert.equal(isMissingCodexSessionFailure({ code: 0, stderr: 'thread not found', stdout: '' }), false)
  assert.equal(isMissingCodexSessionFailure({ code: 1, timedOut: true, stderr: 'thread not found', stdout: '' }), false)
})

test('Codex worker один раз відновлюється після відомого пошкодження models cache', () => {
  const cacheFailure = {
    code: 1,
    stderr: 'ERROR codex_models_manager::cache: failed to load models cache: missing field `base_instructions` at line 97 column 5',
    stdout: '',
  }
  assert.equal(codexRetryableInfrastructureFailureKind(cacheFailure), 'models-cache')
  assert.equal(
    codexRetryableInfrastructureFailureKind({ code: 1, stderr: 'thread 123 not found', stdout: '' }),
    'session',
  )
  assert.equal(
    codexRetryableInfrastructureFailureKind({ code: 1, stderr: 'compile failed', stdout: '' }),
    '',
  )
  assert.equal(codexRetryableInfrastructureFailureKind({ ...cacheFailure, code: 0 }), '')
})

test('worker image має локальні інструменти для коду й усіх дозволених форматів доказів', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
  for (const tool of ['ripgrep', 'ffmpeg', 'poppler-utils', 'python3-openpyxl', 'python3-xlrd']) {
    assert.match(dockerfile, new RegExp(`\\b${tool}\\b`))
  }
})

test('worker image не використовує Codex, несумісний зі спільним host models cache', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
  assert.match(dockerfile, /ARG CODEX_VERSION=0\.150\.1\b/)
})

test('server worker отримує обов’язковий RTK proxy лише для читання', async () => {
  const compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8')
  assert.match(compose, /\$\{RTK_HOST_PATH:\?Set RTK_HOST_PATH\}:\/usr\/local\/bin\/rtk:ro/)
})

test('повторний аудит fast-forward-ить чистий task-worktree до authoritative HEAD', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-codex-baseline-ff-'))
  const repository = path.join(root, 'repo')
  const worktreesDirectory = path.join(root, 'worktrees')
  await mkdir(repository, { recursive: true })
  git(repository, 'init')
  git(repository, 'config', 'user.email', 'worker-test@example.com')
  git(repository, 'config', 'user.name', 'Worker Test')
  await writeFile(path.join(repository, 'app.txt'), 'initial\n', 'utf8')
  git(repository, 'add', 'app.txt')
  git(repository, 'commit', '-m', 'Initial fixture')

  const worker = new CodexWorker({
    store: {},
    rootDirectory: root,
    dataDirectory: root,
    uploadsDirectory: root,
    targetRepository: repository,
    worktreesDirectory,
  })
  const stack = [{ name: 'repo', repositoryPath: repository }]

  try {
    const first = await worker.ensureWorktrees('BUG-BASELINE-FF', stack)
    const oldHead = git(first.worktrees[0].worktreePath, 'rev-parse', 'HEAD')
    await writeFile(path.join(repository, 'main-only.txt'), 'current main\n', 'utf8')
    git(repository, 'add', 'main-only.txt')
    git(repository, 'commit', '-m', 'Advance authoritative main')
    const currentMain = git(repository, 'rev-parse', 'HEAD')
    assert.notEqual(currentMain, oldHead)

    const second = await worker.ensureWorktrees('BUG-BASELINE-FF', stack)
    assert.equal(git(second.worktrees[0].worktreePath, 'rev-parse', 'HEAD'), currentMain)
    assert.equal(second.worktrees[0].baselineCommit, currentMain)
    assert.equal(second.worktrees[0].baselineState, 'fast-forwarded')
    assert.equal(await readFile(path.join(second.worktrees[0].worktreePath, 'main-only.txt'), 'utf8'), 'current main\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('повторний аудит rebases і враховує вже закомічену task-роботу від current main', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-codex-baseline-rebase-'))
  const repository = path.join(root, 'repo')
  const worktreesDirectory = path.join(root, 'worktrees')
  await mkdir(repository, { recursive: true })
  git(repository, 'init')
  git(repository, 'config', 'user.email', 'worker-test@example.com')
  git(repository, 'config', 'user.name', 'Worker Test')
  await writeFile(path.join(repository, 'app.txt'), 'initial\n', 'utf8')
  git(repository, 'add', 'app.txt')
  git(repository, 'commit', '-m', 'Initial fixture')

  const worker = new CodexWorker({
    store: {},
    rootDirectory: root,
    dataDirectory: root,
    uploadsDirectory: root,
    targetRepository: repository,
    worktreesDirectory,
  })
  const stack = [{ name: 'repo', repositoryPath: repository }]

  try {
    const first = await worker.ensureWorktrees('BUG-BASELINE-REBASE', stack)
    const taskWorktree = first.worktrees[0].worktreePath
    await writeFile(path.join(taskWorktree, 'task-only.txt'), 'retained task fix\n', 'utf8')
    git(taskWorktree, 'add', 'task-only.txt')
    git(taskWorktree, 'commit', '-m', 'Retain prior task fix')

    await writeFile(path.join(repository, 'main-only.txt'), 'current main\n', 'utf8')
    git(repository, 'add', 'main-only.txt')
    git(repository, 'commit', '-m', 'Advance authoritative main')
    const currentMain = git(repository, 'rev-parse', 'HEAD')

    const second = await worker.ensureWorktrees('BUG-BASELINE-REBASE', stack)
    const taskHead = git(taskWorktree, 'rev-parse', 'HEAD')
    assert.equal(second.worktrees[0].baselineCommit, currentMain)
    assert.equal(second.worktrees[0].baselineState, 'rebased task commits')
    assert.equal(git(taskWorktree, 'merge-base', '--is-ancestor', currentMain, taskHead), '')
    assert.equal(await readFile(path.join(taskWorktree, 'main-only.txt'), 'utf8'), 'current main\n')
    assert.equal(await readFile(path.join(taskWorktree, 'task-only.txt'), 'utf8'), 'retained task fix\n')

    assert.deepEqual(await collectWorktreeChanges(second.worktrees), {
      files: ['repo/task-only.txt'],
      repositories: ['repo'],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('конфліктні task-коміти зберігаються у read-only ref, а аудит стартує від authoritative HEAD', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-codex-baseline-preserve-'))
  const repository = path.join(root, 'repo')
  const worktreesDirectory = path.join(root, 'worktrees')
  await mkdir(repository, { recursive: true })
  git(repository, 'init')
  git(repository, 'config', 'user.email', 'worker-test@example.com')
  git(repository, 'config', 'user.name', 'Worker Test')
  await writeFile(path.join(repository, 'app.txt'), 'initial\n', 'utf8')
  git(repository, 'add', 'app.txt')
  git(repository, 'commit', '-m', 'Initial fixture')

  const worker = new CodexWorker({
    store: {},
    rootDirectory: root,
    dataDirectory: root,
    uploadsDirectory: root,
    targetRepository: repository,
    worktreesDirectory,
  })
  const stack = [{ name: 'repo', repositoryPath: repository }]

  try {
    const first = await worker.ensureWorktrees('BUG-BASELINE-PRESERVE', stack)
    const taskWorktree = first.worktrees[0].worktreePath
    await writeFile(path.join(taskWorktree, 'app.txt'), 'older task implementation\n', 'utf8')
    git(taskWorktree, 'add', 'app.txt')
    git(taskWorktree, 'commit', '-m', 'Older task implementation')
    const taskCommit = git(taskWorktree, 'rev-parse', 'HEAD')

    await writeFile(path.join(repository, 'app.txt'), 'new consolidated implementation\n', 'utf8')
    git(repository, 'add', 'app.txt')
    git(repository, 'commit', '-m', 'Consolidated authoritative fix')
    const currentMain = git(repository, 'rev-parse', 'HEAD')

    const second = await worker.ensureWorktrees('BUG-BASELINE-PRESERVE', stack)
    const preservedRef = `refs/gba-qa/preserved/bug-baseline-preserve/${taskCommit}`

    assert.equal(git(taskWorktree, 'rev-parse', 'HEAD'), currentMain)
    assert.equal(git(taskWorktree, 'branch', '--show-current'), 'codex/qa-bug-baseline-preserve')
    assert.equal(second.worktrees[0].baselineCommit, currentMain)
    assert.equal(
      second.worktrees[0].baselineState,
      `current; conflicting prior task commits preserved read-only at ${preservedRef}`,
    )
    assert.equal(git(repository, 'rev-parse', preservedRef), taskCommit)
    assert.equal(git(repository, 'show', `${preservedRef}:app.txt`), 'older task implementation')
    assert.equal(await readFile(path.join(taskWorktree, 'app.txt'), 'utf8'), 'new consolidated implementation\n')
    assert.deepEqual(await collectWorktreeChanges(second.worktrees), { files: [], repositories: [] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('baseline sync не затирає конфліктний незакомічений WIP', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-codex-baseline-wip-'))
  const repository = path.join(root, 'repo')
  const worktreesDirectory = path.join(root, 'worktrees')
  await mkdir(repository, { recursive: true })
  git(repository, 'init')
  git(repository, 'config', 'user.email', 'worker-test@example.com')
  git(repository, 'config', 'user.name', 'Worker Test')
  await writeFile(path.join(repository, 'app.txt'), 'initial\n', 'utf8')
  git(repository, 'add', 'app.txt')
  git(repository, 'commit', '-m', 'Initial fixture')

  const worker = new CodexWorker({
    store: {},
    rootDirectory: root,
    dataDirectory: root,
    uploadsDirectory: root,
    targetRepository: repository,
    worktreesDirectory,
  })
  const stack = [{ name: 'repo', repositoryPath: repository }]

  try {
    const first = await worker.ensureWorktrees('BUG-BASELINE-WIP', stack)
    const taskWorktree = first.worktrees[0].worktreePath
    await writeFile(path.join(taskWorktree, 'app.txt'), 'uncommitted task WIP\n', 'utf8')
    await writeFile(path.join(repository, 'app.txt'), 'new authoritative value\n', 'utf8')
    git(repository, 'add', 'app.txt')
    git(repository, 'commit', '-m', 'Conflicting main change')

    await assert.rejects(
      worker.ensureWorktrees('BUG-BASELINE-WIP', stack),
      /WIP збережено без змін/,
    )
    assert.equal(await readFile(path.join(taskWorktree, 'app.txt'), 'utf8'), 'uncommitted task WIP\n')
    assert.equal(git(taskWorktree, 'status', '--short'), 'M app.txt')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex worker підключає legacy references окремо від writable stack', () => {
  const previous = process.env.CODEX_REFERENCE_REPOS_CONSOLE
  process.env.CODEX_REFERENCE_REPOS_CONSOLE = '/tmp/gba_client'
  try {
    const worker = new CodexWorker({
      store: {},
      rootDirectory: '/tmp',
      dataDirectory: '/tmp',
      uploadsDirectory: '/tmp',
      targetRepository: '/tmp',
    })
    assert.deepEqual(worker.resolveProjectReferences('console'), [{
      name: 'gba_client',
      repositoryPath: '/tmp/gba_client',
    }])
    assert.deepEqual(worker.resolveProjectStack('console'), [{
      name: 'tmp',
      repositoryPath: '/tmp',
    }])
  } finally {
    if (previous === undefined) delete process.env.CODEX_REFERENCE_REPOS_CONSOLE
    else process.env.CODEX_REFERENCE_REPOS_CONSOLE = previous
  }
})

test('Codex worker відхиляє heartbeat, який не встигає оновити lease', () => {
  assert.throws(() => new CodexWorker({
    store: {},
    rootDirectory: '/tmp',
    dataDirectory: '/tmp',
    uploadsDirectory: '/tmp',
    leaseTtlMs: 5_000,
    heartbeatIntervalMs: 5_000,
  }), /має бути меншим/)
})

test('Codex worker не маскує timeout успішним exit code без result-файлу', () => {
  assert.equal(
    codexExecutionFailureReason({ code: 0, timedOut: true, stdout: '', stderr: '' }, 90 * 60_000),
    'Codex перевищив таймаут 90 хв.',
  )
  assert.equal(
    codexExecutionFailureReason({ code: 0, timedOut: false, stdout: '', stderr: '' }, 90 * 60_000),
    null,
  )
})

test('зупинка detached Codex надсилає сигнал усій process group', () => {
  const originalKill = process.kill
  const calls = []
  process.kill = (pid, signal) => {
    calls.push({ pid, signal })
    return true
  }
  try {
    terminateProcessTree({ pid: 4321, gbaProcessGroup: true, kill: () => assert.fail('child.kill не очікувався') }, 'SIGTERM')
    assert.deepEqual(calls, [{ pid: -4321, signal: 'SIGTERM' }])
  } finally {
    process.kill = originalKill
  }
})

test('Codex worker обробляє чергу строго по одній задачі', async () => {
  const queue = Array.from({ length: 5 }, (_, index) => ({
    id: `RUN-PARALLEL-${index + 1}`,
    taskId: `BUG-PARALLEL-${index + 1}`,
  }))
  const expectedRunIds = queue.map((run) => run.id)
  const started = []
  const releases = new Map()
  let active = 0
  let maximumActive = 0
  const store = {
    claimNextAgentRun: () => queue.shift() ?? null,
    claimNextCleanupRun: () => null,
    updateAgentRun: () => undefined,
  }
  const worker = new CodexWorker({
    store,
    rootDirectory: '/tmp',
    dataDirectory: '/tmp',
    uploadsDirectory: '/tmp',
    concurrency: 3,
  })
  worker.processRun = async (run) => {
    started.push(run.id)
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => releases.set(run.id, resolve))
    active -= 1
  }

  worker.tick()
  await waitFor(() => started.length === 1)
  assert.deepEqual(started, ['RUN-PARALLEL-1'])
  assert.equal(maximumActive, 1)
  assert.equal(worker.activeRuns.size, 1)

  for (let index = 1; index <= 5; index += 1) {
    releases.get(`RUN-PARALLEL-${index}`)()
    if (index < 5) await waitFor(() => started.length === index + 1)
  }
  await waitFor(() => worker.activeRuns.size === 0)
  assert.deepEqual(started, expectedRunIds)
  assert.equal(maximumActive, 1)
  await worker.stop()
})

test('quality gate відхиляє недоведений fixed і сторонній global test config', () => {
  const result = {
    outcome: 'fixed',
    rootCause: 'Поле додано не на тому етапі workflow.',
    acceptanceEvidence: [{ criterion: 'Поле після створення', evidence: 'Сусідня форма', status: 'not_met' }],
    referenceEvidence: ['Переглянуто поточний компонент'],
    tests: ['PASS targeted test'],
    changedFiles: ['gba_console/src/form.tsx', 'gba_console/vitest.config.cjs'],
    reviewedAttachments: ['screen.jpg'],
    attachmentEvidence: [{ name: 'screen.jpg', observation: 'Post-create логістичний екран' }],
    reviewedComments: [],
    commentEvidence: [],
    scopeReview: { diffReviewed: true, unrelatedFiles: [] },
    releasePlan: { repositories: ['gba_console'] },
  }

  const failures = fixedResultQualityFailures(result, {
    task: {
      title: 'Додати знижку до інвойса',
      description: 'Поле після створення інвойса',
      comments: [{ id: 'COMMENT-QA', author: 'QA', body: 'Перевірити саме після створення.' }],
    },
    mediaPaths: [{ name: 'screen.jpg', available: true }],
    actualChangedFiles: ['gba_console/src/form.tsx', 'gba_console/vitest.config.cjs'],
    actualRepositories: ['gba_console'],
  })

  assert.ok(failures.some((failure) => /не всі acceptance-критерії/.test(failure)))
  assert.ok(failures.some((failure) => /глобальні build\/test-конфіги/.test(failure)))
  assert.ok(failures.some((failure) => /коментар не зафіксовано.*COMMENT-QA/.test(failure)))
  assert.ok(failures.some((failure) => /немає конкретного висновку.*COMMENT-QA/.test(failure)))
})

test('quality gate дозволяє доказаний verified лише з повністю чистим git', () => {
  const result = {
    outcome: 'verified',
    rootCause: 'Поточний main уже містить виправлення точного сценарію задачі.',
    acceptanceEvidence: [{
      criterion: 'Точний сценарій працює',
      evidence: 'PASS regression test і current component contract',
      status: 'met',
    }],
    referenceEvidence: ['src/form.tsx — current contract підтверджує потрібний стан'],
    tests: ['PASS targeted regression test'],
    changedFiles: [],
    reviewedAttachments: ['screen.png'],
    attachmentEvidence: [{ name: 'screen.png', observation: 'Форма показує очікуваний стан' }],
    reviewedComments: ['COMMENT-QA'],
    commentEvidence: [{ id: 'COMMENT-QA', observation: 'QA просить перевірити той самий сценарій' }],
    scopeReview: { diffReviewed: true, unrelatedFiles: [] },
    releasePlan: {
      repositories: [],
      migrationFiles: [],
      services: [],
      postDeployChecks: [{
        label: 'current dev scenario',
        url: 'http://127.0.0.1/health',
        expectedStatus: 200,
        contains: '',
      }],
    },
  }
  const context = {
    task: {
      title: 'Перевірити форму',
      description: 'Очікуваний стан форми',
      comments: [{ id: 'COMMENT-QA', author: 'QA', body: 'Перевірити точний сценарій.' }],
    },
    mediaPaths: [{ name: 'screen.png', available: true }],
    actualChangedFiles: [],
    actualRepositories: [],
  }

  assert.deepEqual(fixedResultQualityFailures(result, context), [])
  assert.ok(fixedResultQualityFailures(result, {
    ...context,
    actualChangedFiles: ['gba_console/src/form.tsx'],
    actualRepositories: ['gba_console'],
  }).some((failure) => /verified забороняє зміни/.test(failure)))
})

test('quality gate окремо зараховує вкладення з однаковими назвами', () => {
  const result = {
    outcome: 'verified',
    rootCause: 'Поточний main вже містить виправлення точного сценарію.',
    acceptanceEvidence: [{ criterion: 'Сценарій працює', evidence: 'PASS regression test', status: 'met' }],
    referenceEvidence: ['src/form.tsx — current contract'],
    tests: ['PASS targeted regression test'],
    changedFiles: [],
    reviewedAttachments: ['screen.png', 'screen.png'],
    attachmentEvidence: [
      { name: 'screen.png (attachment 1)', observation: 'Перший файл показує стан до refresh' },
      { name: 'screen.png (attachment 2)', observation: 'Другий файл показує стан після refresh' },
    ],
    reviewedComments: [],
    commentEvidence: [],
    scopeReview: { diffReviewed: true, unrelatedFiles: [] },
    releasePlan: { repositories: [], migrationFiles: [], services: [], postDeployChecks: [] },
  }
  const context = {
    task: { title: 'Перевірити refresh', description: 'Два скріни з однаковою назвою' },
    mediaPaths: [{ name: 'screen.png' }, { name: 'screen.png' }],
    actualChangedFiles: [],
    actualRepositories: [],
  }

  assert.deepEqual(fixedResultQualityFailures(result, context), [])

  const incomplete = {
    ...result,
    reviewedAttachments: ['screen.png'],
    attachmentEvidence: result.attachmentEvidence.slice(0, 1),
  }
  const failures = fixedResultQualityFailures(incomplete, context)
  assert.ok(failures.some((failure) => /вкладення не зафіксовано/.test(failure)))
  assert.ok(failures.some((failure) => /немає конкретного спостереження/.test(failure)))
})

test('Codex worker зберігає verified як completed без штучного diff', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-codex-verified-'))
  const targetRepository = path.join(root, 'target')
  const dataDirectory = path.join(root, 'data')
  const uploadsDirectory = path.join(root, 'uploads')
  const worktreesDirectory = path.join(root, 'worktrees')
  const fakeCodex = path.join(root, 'fake-codex.mjs')
  await mkdir(targetRepository, { recursive: true })
  await mkdir(uploadsDirectory, { recursive: true })

  git(targetRepository, 'init')
  git(targetRepository, 'config', 'user.email', 'worker-test@example.com')
  git(targetRepository, 'config', 'user.name', 'Worker Test')
  await writeFile(path.join(targetRepository, 'app.txt'), 'already fixed\n', 'utf8')
  git(targetRepository, 'add', 'app.txt')
  git(targetRepository, 'commit', '-m', 'Verified fixture')

  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const outputPath = args[args.indexOf('--output-last-message') + 1]
writeFileSync(outputPath, JSON.stringify({
  outcome: 'verified',
  summary: 'Поточний main уже відповідає задачі.',
  rootCause: 'Потрібна поведінка вже реалізована у current main і захищена тестом.',
  acceptanceEvidence: [{ criterion: 'Поведінка наявна', evidence: 'PASS current contract regression', status: 'met' }],
  referenceEvidence: ['target/app.txt — current contract'],
  tests: ['PASS current contract regression'],
  changedFiles: [],
  reviewedAttachments: [],
  attachmentEvidence: [],
  reviewedComments: [],
  commentEvidence: [],
  scopeReview: { diffReviewed: true, unrelatedFiles: [] },
  releasePlan: { repositories: [], migrationFiles: [], services: [], postDeployChecks: [{ label: 'fixture', url: 'http://127.0.0.1/health', expectedStatus: 200, contains: '' }] }
}), 'utf8')
`, 'utf8')
  await chmod(fakeCodex, 0o755)

  const previousStack = process.env.CODEX_REPOS_CONSOLE
  process.env.CODEX_REPOS_CONSOLE = targetRepository
  const store = new TaskStore(dataDirectory)
  try {
    await store.ensureReady()
    store.transaction(() => {
      for (const task of getSeedTasks()) store.insertTask(task)
    })
    store.patch('BUG-1049', { status: 'done' })
    const queued = store.enqueueAgentRun('RUN-VERIFIED-1', 'BUG-1049', 'manual')
    assert.equal(queued.run.inputSnapshot.status, 'done')

    const worker = new CodexWorker({
      store,
      rootDirectory: root,
      dataDirectory,
      uploadsDirectory,
      targetRepository,
      worktreesDirectory,
      codexBinary: fakeCodex,
      timeoutMs: 10_000,
    })
    await worker.processRun(store.claimNextAgentRun())

    const result = store.findAgentRun('RUN-VERIFIED-1')
    const details = JSON.parse(result.details)
    assert.equal(result.status, 'completed')
    assert.equal(details.outcome, 'verified')
    assert.equal(details.qualityGate.applied, true)
    assert.equal(details.qualityGate.passed, true)
    assert.deepEqual(details.changedFiles, [])
    assert.equal(store.find('BUG-1049').status, 'in_progress')
    assert.equal(git(targetRepository, 'status', '--short'), '')
  } finally {
    if (previousStack === undefined) delete process.env.CODEX_REPOS_CONSOLE
    else process.env.CODEX_REPOS_CONSOLE = previousStack
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex worker працює в окремому worktree та зберігає результат', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-codex-worker-'))
  const targetRepository = path.join(root, 'target')
  const dataDirectory = path.join(root, 'data')
  const uploadsDirectory = path.join(root, 'uploads')
  const worktreesDirectory = path.join(root, 'worktrees')
  const fakeCodex = path.join(root, 'fake-codex.mjs')
  await mkdir(targetRepository, { recursive: true })
  await mkdir(uploadsDirectory, { recursive: true })

  git(targetRepository, 'init')
  git(targetRepository, 'config', 'user.email', 'worker-test@example.com')
  git(targetRepository, 'config', 'user.name', 'Worker Test')
  await writeFile(path.join(targetRepository, 'app.txt'), 'before\n', 'utf8')
  git(targetRepository, 'add', 'app.txt')
  git(targetRepository, 'commit', '-m', 'Initial fixture')

  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const outputPath = args[args.indexOf('--output-last-message') + 1]
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
writeFileSync('prompt.txt', prompt, 'utf8')
writeFileSync('target/app.txt', 'after\\n', 'utf8')
writeFileSync(outputPath, JSON.stringify({
  outcome: 'fixed',
  summary: 'Тестове виправлення готове.',
  rootCause: 'Fixture доводить точну причину тестової зміни.',
  acceptanceEvidence: [{ criterion: 'Файл змінено', evidence: 'target/app.txt має after', status: 'met' }],
  referenceEvidence: ['target/app.txt — current contract'],
  tests: ['PASS fixture test'],
  changedFiles: ['app.txt'],
  reviewedAttachments: ['proof.png', 'walkthrough.mp4', 'missing.mov — недоступне'],
  attachmentEvidence: [
    { name: 'proof.png', observation: 'Тестове зображення переглянуто' },
    { name: 'walkthrough.mp4', observation: 'Тестове відео переглянуто' },
    { name: 'missing.mov', observation: 'Файл недоступний, вміст не вигадувався' }
  ],
  reviewedComments: ['staff-comments', 'COMMENT-BEFORE'],
  commentEvidence: [
    { id: 'staff-comments', observation: 'Legacy-коментар уточнює внутрішню перевірку команди' },
    { id: 'COMMENT-BEFORE', observation: 'Коментар вимагає перевірити точний сценарій очищення поля' }
  ],
  scopeReview: { diffReviewed: true, unrelatedFiles: [] },
  releasePlan: { repositories: ['target'], migrationFiles: [], services: [], postDeployChecks: [{ label: 'fixture', url: 'http://127.0.0.1/health', expectedStatus: 200, contains: '' }] }
}), 'utf8')
`, 'utf8')
  await chmod(fakeCodex, 0o755)

  const store = new TaskStore(dataDirectory)
  try {
    await store.ensureReady()
    store.transaction(() => {
      for (const task of getSeedTasks()) store.insertTask(task)
    })
    store.patch('BUG-1051', {
      staffComments: 'Внутрішній legacy-коментар команди.',
      reviewComment: 'Після першого виправлення пошук усе ще падає на порожньому рядку.',
    })
    store.addTaskComment('COMMENT-BEFORE', 'BUG-1051', {
      parentId: null,
      authorUserId: null,
      author: 'Олена',
      body: 'Окремо перевір очищення поля пошуку.',
    })
    await writeFile(path.join(uploadsDirectory, 'proof.png'), 'image fixture', 'utf8')
    await writeFile(path.join(uploadsDirectory, 'walkthrough.mp4'), 'video fixture', 'utf8')
    store.addAttachments('BUG-1051', [
      {
        id: 'ATTACHMENT-IMAGE',
        name: 'proof.png',
        url: '/uploads/proof.png',
        type: 'image/png',
        size: 13,
        kind: 'image',
      },
      {
        id: 'ATTACHMENT-VIDEO',
        name: 'walkthrough.mp4',
        url: '/uploads/walkthrough.mp4',
        type: 'video/mp4',
        size: 13,
        kind: 'video',
      },
      {
        id: 'ATTACHMENT-MISSING',
        name: 'missing.mov',
        url: '/uploads/missing.mov',
        type: 'video/quicktime',
        size: 999,
        kind: 'video',
      },
    ])
    const queued = store.enqueueAgentRun('RUN-TEST-1', 'BUG-1051', 'manual')
    assert.equal(queued.created, true)
    assert.equal(queued.run.reviewComment, 'Після першого виправлення пошук усе ще падає на порожньому рядку.')
    assert.equal(queued.run.inputSnapshot.title, 'Пошук падає після очищення поля')
    assert.equal(queued.run.inputSnapshot.staffComments, 'Внутрішній legacy-коментар команди.')
    assert.deepEqual(queued.run.inputSnapshot.comments.map(({ id, body }) => ({ id, body })), [
      { id: 'COMMENT-BEFORE', body: 'Окремо перевір очищення поля пошуку.' },
    ])
    store.patch('BUG-1051', { reviewComment: 'Це новіший коментар, який не належить RUN-TEST-1.' })
    store.addTaskComment('COMMENT-AFTER', 'BUG-1051', {
      parentId: null,
      authorUserId: null,
      author: 'Ігор',
      body: 'Це новіший внутрішній коментар, який не належить RUN-TEST-1.',
    })
    const run = store.claimNextAgentRun()

    const worker = new CodexWorker({
      store,
      rootDirectory: root,
      dataDirectory,
      uploadsDirectory,
      targetRepository,
      worktreesDirectory,
      codexBinary: fakeCodex,
      buildNumber: 'worker-test-build',
      timeoutMs: 10_000,
    })
    await worker.processRun(run)

    const result = store.findAgentRun(run.id)
    assert.equal(result.status, 'completed')
    assert.equal(result.summary, 'Тестове виправлення готове.')
    assert.equal(store.find('BUG-1051').status, 'in_progress')
    // Вердикт Codex НЕ кладе задачу в бакет білда: код ще не в мейнлайні.
    // Мітку ставить реліз-воркер після успішного мерджу й деплою.
    assert.deepEqual(store.ensureBuild('worker-test-build').bugs, [])
    const schema = JSON.parse(await readFile(path.join(dataDirectory, 'agent-runs', `${run.id}-schema.json`), 'utf8'))
    assert.equal(schema.properties.outcome.type, 'string')
    assert.equal(schema.properties.acceptanceEvidence.minItems, 1)
    assert.equal(schema.properties.reviewedAttachments.type, 'array')
    assert.equal(schema.properties.reviewedComments.type, 'array')
    assert.equal(schema.properties.scopeReview.type, 'object')
    await assert.rejects(readFile(path.join(dataDirectory, 'agent-runs', 'result-schema.json'), 'utf8'), /ENOENT/)
    assert.equal(await readFile(path.join(worktreesDirectory, 'bug-1051', 'target', 'app.txt'), 'utf8'), 'after\n')
    const prompt = await readFile(path.join(worktreesDirectory, 'bug-1051', 'prompt.txt'), 'utf8')
    assert.match(prompt, /Після першого виправлення пошук усе ще падає на порожньому рядку/)
    assert.match(prompt, /Статус задачі на момент запуску: new/)
    assert.match(prompt, /proof\.png.*image\/png/)
    assert.match(prompt, /walkthrough\.mp4.*video\/mp4/)
    assert.match(prompt, /missing\.mov.*ФАЙЛ НЕДОСТУПНИЙ/)
    assert.match(prompt, /Відкрий кожне доступне вкладення/)
    assert.match(prompt, /pdftotext -layout/)
    assert.match(prompt, /XLS читай.*xlrd/)
    assert.match(prompt, /XLSX.*openpyxl/)
    assert.match(prompt, /ffprobe.*ffmpeg/)
    assert.match(prompt, /Не запускай одночасно кілька dotnet build\/test/)
    assert.match(prompt, /точні тести послідовно з --no-build\/--no-restore/)
    assert.match(prompt, /Acceptance contract/)
    assert.match(prompt, /Схожий чи сусідній екран не вважається виправленням/)
    assert.match(prompt, /переглянь повний git diff/)
    assert.match(prompt, /створи НОВУ forward-only міграцію/)
    assert.match(prompt, /release-worker сам застосує штатний migrator/)
    assert.match(prompt, /audit-only outcome=verified.*точні regression-тести/)
    assert.match(prompt, /один ізольований повтор падіння достатній/)
    assert.match(prompt, /Внутрішній legacy-коментар команди/)
    assert.match(prompt, /Окремо перевір очищення поля пошуку/)
    assert.doesNotMatch(prompt, /Це новіший коментар, який не належить RUN-TEST-1/)
    assert.doesNotMatch(prompt, /Це новіший внутрішній коментар, який не належить RUN-TEST-1/)
    assert.deepEqual(
      JSON.parse(result.details).reviewedAttachments,
      ['proof.png', 'walkthrough.mp4', 'missing.mov — недоступне'],
    )
    assert.deepEqual(
      JSON.parse(result.details).reviewedComments,
      ['staff-comments', 'COMMENT-BEFORE'],
    )
    assert.equal(JSON.parse(result.details).commentEvidence.length, 2)
    assert.equal(JSON.parse(result.details).qualityGate.applied, true)
    assert.equal(JSON.parse(result.details).qualityGate.passed, true)
    assert.equal(await readFile(path.join(targetRepository, 'app.txt'), 'utf8'), 'before\n')
    assert.equal(git(targetRepository, 'status', '--short'), '')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex worker зберігає постійний контекст і продовжує окрему сесію задачі', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-codex-context-'))
  const targetRepository = path.join(root, 'target')
  const dataDirectory = path.join(root, 'data')
  const uploadsDirectory = path.join(root, 'uploads')
  const worktreesDirectory = path.join(root, 'worktrees')
  const contextFile = path.join(root, 'worker-context.md')
  const fakeCodex = path.join(root, 'fake-codex.mjs')
  const sessionId = '019fe123-aabb-7ccd-8eef-0123456789ab'
  await mkdir(targetRepository, { recursive: true })
  await mkdir(uploadsDirectory, { recursive: true })

  git(targetRepository, 'init')
  git(targetRepository, 'config', 'user.email', 'worker-test@example.com')
  git(targetRepository, 'config', 'user.name', 'Worker Test')
  await writeFile(path.join(targetRepository, 'app.txt'), 'before\n', 'utf8')
  git(targetRepository, 'add', 'app.txt')
  git(targetRepository, 'commit', '-m', 'Initial fixture')
  await writeFile(contextFile, 'Контекст версії 1: звіряй суми до копійки.', 'utf8')

  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const outputPath = args[args.indexOf('--output-last-message') + 1]
const historyPath = 'codex-invocations.jsonl'
const count = existsSync(historyPath) ? readFileSync(historyPath, 'utf8').trim().split('\\n').filter(Boolean).length + 1 : 1
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
appendFileSync(historyPath, JSON.stringify(args) + '\\n', 'utf8')
writeFileSync(\`prompt-\${count}.txt\`, prompt, 'utf8')
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: '${sessionId}' }) + '\\n')
if (count === 3) {
  process.stderr.write('thread ${sessionId} not found\\n')
  process.exit(1)
}
writeFileSync(outputPath, JSON.stringify({
  outcome: 'fixed',
  summary: \`Виправлення \${count} готове.\`,
  rootCause: 'Fixture доводить збереження окремої Codex-сесії.',
  acceptanceEvidence: [{ criterion: 'Сесія продовжена', evidence: 'invocation history', status: 'met' }],
  referenceEvidence: ['target/app.txt — current contract'],
  tests: ['PASS fixture test'],
  changedFiles: ['app.txt'],
  reviewedAttachments: [],
  attachmentEvidence: [],
  reviewedComments: [],
  commentEvidence: [],
  scopeReview: { diffReviewed: true, unrelatedFiles: [] },
  releasePlan: { repositories: ['target'], migrationFiles: [], services: [], postDeployChecks: [{ label: 'fixture', url: 'http://127.0.0.1/health', expectedStatus: 200, contains: '' }] }
}), 'utf8')
`, 'utf8')
  await chmod(fakeCodex, 0o755)

  const store = new TaskStore(dataDirectory)
  try {
    await store.ensureReady()
    store.transaction(() => {
      for (const task of getSeedTasks()) store.insertTask(task)
    })
    store.enqueueAgentRun('RUN-CONTEXT-1', 'BUG-1051', 'manual')

    const worker = new CodexWorker({
      store,
      rootDirectory: root,
      dataDirectory,
      uploadsDirectory,
      targetRepository,
      worktreesDirectory,
      contextFile,
      codexBinary: fakeCodex,
      timeoutMs: 10_000,
    })
    await worker.processRun(store.claimNextAgentRun())

    const firstRun = store.findAgentRun('RUN-CONTEXT-1')
    assert.equal(firstRun.codexSessionId, sessionId)
    assert.match(firstRun.contextSnapshot, /Контекст версії 1/)
    const releasedAt = new Date(Date.now() + 1_000).toISOString()
    store.updateAgentRunRelease(firstRun.id, {
      status: 'released',
      attempts: 1,
      repositories: ['target'],
      releasedAt,
    }, 'done')

    await writeFile(contextFile, 'Контекст версії 2: повторний запуск пам’ятає історію задачі.', 'utf8')
    store.patch('BUG-1051', { status: 'review_again', reviewComment: 'Перевір виправлення ще раз.' })
    const queued = store.enqueueAgentRun('RUN-CONTEXT-2', 'BUG-1051', 'review_again')
    assert.equal(queued.run.codexSessionId, sessionId)
    await worker.processRun(store.claimNextAgentRun())

    const secondRun = store.findAgentRun('RUN-CONTEXT-2')
    assert.equal(secondRun.codexSessionId, sessionId)
    assert.match(secondRun.contextSnapshot, /Контекст версії 2/)
    assert.match(secondRun.contextSnapshot, /BUG-1051/)
    assert.match(secondRun.contextSnapshot, /Виправлення 1 готове/)

    const jobDirectory = path.join(worktreesDirectory, 'bug-1051')
    const invocations = (await readFile(path.join(jobDirectory, 'codex-invocations.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(invocations.length, 2)
    assert.equal(invocations[0].includes('resume'), false)
    assert.equal(invocations[1][invocations[1].indexOf('resume') + 1], '--json')
    assert.equal(invocations[1].includes(sessionId), true)
    assert.match(await readFile(path.join(jobDirectory, 'prompt-2.txt'), 'utf8'), /Перевір виправлення ще раз/)

    store.updateAgentRunRelease(secondRun.id, {
      status: 'released',
      attempts: 1,
      repositories: ['target'],
      releasedAt: new Date(Date.now() + 2_000).toISOString(),
    }, 'done')
    store.updateAgentRun(secondRun.id, { codexSessionId: '' })
    store.patch('BUG-1051', {
      status: 'review_again',
      reviewComment: 'Почни чисту сесію після втрати rollout.',
    })
    const cleanSessionRun = store.enqueueAgentRun(
      'RUN-CONTEXT-3',
      'BUG-1051',
      'review_again',
    )
    assert.equal(cleanSessionRun.run.codexSessionId, '')
    await worker.processRun(store.claimNextAgentRun())

    const retriedRun = store.findAgentRun('RUN-CONTEXT-3')
    assert.notEqual(retriedRun.status, 'failed')
    assert.equal(retriedRun.codexSessionId, sessionId)
    const retriedInvocations = (await readFile(path.join(jobDirectory, 'codex-invocations.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(retriedInvocations.length, 4)
    assert.equal(retriedInvocations[2].includes('resume'), false)
    assert.equal(retriedInvocations[3].includes('resume'), false)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex worker готує фул-стек worktree-и для всіх репозиторіїв проєкту', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-codex-stack-'))
  const frontendRepository = path.join(root, 'frontend')
  const backendRepository = path.join(root, 'backend')
  const dataDirectory = path.join(root, 'data')
  const uploadsDirectory = path.join(root, 'uploads')
  const worktreesDirectory = path.join(root, 'worktrees')
  const fakeCodex = path.join(root, 'fake-codex.mjs')
  await mkdir(uploadsDirectory, { recursive: true })

  for (const repository of [frontendRepository, backendRepository]) {
    await mkdir(repository, { recursive: true })
    git(repository, 'init')
    git(repository, 'config', 'user.email', 'worker-test@example.com')
    git(repository, 'config', 'user.name', 'Worker Test')
    await writeFile(path.join(repository, 'app.txt'), 'before\n', 'utf8')
    git(repository, 'add', 'app.txt')
    git(repository, 'commit', '-m', 'Initial fixture')
  }

  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const outputPath = args[args.indexOf('--output-last-message') + 1]
writeFileSync('frontend/app.txt', 'front-after\\n', 'utf8')
writeFileSync('backend/app.txt', 'back-after\\n', 'utf8')
writeFileSync(outputPath, JSON.stringify({
  outcome: 'fixed',
  summary: 'Фул-стек виправлення готове.',
  rootCause: 'Fixture потребує узгодженої зміни обох репозиторіїв.',
  acceptanceEvidence: [{ criterion: 'Обидва файли змінено', evidence: 'front/back after', status: 'met' }],
  referenceEvidence: ['frontend/app.txt і backend/app.txt — current contract'],
  tests: ['PASS fixture test'],
  changedFiles: ['frontend/app.txt', 'backend/app.txt'],
  reviewedAttachments: [],
  attachmentEvidence: [],
  reviewedComments: [],
  commentEvidence: [],
  scopeReview: { diffReviewed: true, unrelatedFiles: [] },
  releasePlan: { repositories: ['frontend', 'backend'], migrationFiles: [], services: [], postDeployChecks: [{ label: 'fixture', url: 'http://127.0.0.1/health', expectedStatus: 200, contains: '' }] }
}), 'utf8')
`, 'utf8')
  await chmod(fakeCodex, 0o755)

  const previousStack = process.env.CODEX_REPOS_CONSOLE
  process.env.CODEX_REPOS_CONSOLE = `${frontendRepository},${backendRepository}`
  const store = new TaskStore(dataDirectory)
  try {
    await store.ensureReady()
    store.transaction(() => {
      for (const task of getSeedTasks()) store.insertTask(task)
    })
    const queued = store.enqueueAgentRun('RUN-STACK-1', 'BUG-1050', 'manual')
    assert.equal(queued.created, true)
    const run = store.claimNextAgentRun()

    const worker = new CodexWorker({
      store,
      rootDirectory: root,
      dataDirectory,
      uploadsDirectory,
      targetRepository: frontendRepository,
      worktreesDirectory,
      codexBinary: fakeCodex,
      buildNumber: 'stack-test-build',
      timeoutMs: 10_000,
    })
    await worker.processRun(run)

    const result = store.findAgentRun(run.id)
    assert.equal(result.status, 'completed')
    assert.equal(result.worktreePath, path.join(worktreesDirectory, 'bug-1050'))
    assert.equal(await readFile(path.join(worktreesDirectory, 'bug-1050', 'frontend', 'app.txt'), 'utf8'), 'front-after\n')
    assert.equal(await readFile(path.join(worktreesDirectory, 'bug-1050', 'backend', 'app.txt'), 'utf8'), 'back-after\n')
    assert.equal(await readFile(path.join(frontendRepository, 'app.txt'), 'utf8'), 'before\n')
    assert.equal(await readFile(path.join(backendRepository, 'app.txt'), 'utf8'), 'before\n')
    assert.equal(git(frontendRepository, 'status', '--short'), '')
    assert.equal(git(backendRepository, 'status', '--short'), '')
  } finally {
    if (previousStack === undefined) delete process.env.CODEX_REPOS_CONSOLE
    else process.env.CODEX_REPOS_CONSOLE = previousStack
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex worker ізолює залежності у worktree і диктує перевірки репозиторію', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-codex-checks-'))
  const repository = path.join(root, 'gba_console')
  const dataDirectory = path.join(root, 'data')
  const uploadsDirectory = path.join(root, 'uploads')
  const worktreesDirectory = path.join(root, 'worktrees')
  const fakeCodex = path.join(root, 'fake-codex.mjs')
  await mkdir(repository, { recursive: true })
  await mkdir(uploadsDirectory, { recursive: true })

  git(repository, 'init')
  git(repository, 'config', 'user.email', 'worker-test@example.com')
  git(repository, 'config', 'user.name', 'Worker Test')
  await writeFile(path.join(repository, 'app.txt'), 'before\n', 'utf8')
  await writeFile(path.join(repository, '.gitignore'), 'node_modules/\n', 'utf8')
  git(repository, 'add', 'app.txt', '.gitignore')
  git(repository, 'commit', '-m', 'Initial fixture')

  await mkdir(path.join(repository, 'node_modules'), { recursive: true })
  await writeFile(path.join(repository, 'node_modules', 'marker.txt'), 'dependency\n', 'utf8')

  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const outputPath = args[args.indexOf('--output-last-message') + 1]
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
writeFileSync('prompt.txt', prompt, 'utf8')
writeFileSync(outputPath, JSON.stringify({
  outcome: 'fixed',
  summary: 'Перевірки пройдені.',
  rootCause: 'Fixture помилково стверджує, що змін не потрібно.',
  acceptanceEvidence: [{ criterion: 'Зміна присутня', evidence: 'Немає diff', status: 'met' }],
  referenceEvidence: ['target/app.txt — current contract'],
  tests: ['PASS npx tsc --noEmit'],
  changedFiles: [],
  reviewedAttachments: [],
  attachmentEvidence: [],
  reviewedComments: [],
  commentEvidence: [],
  scopeReview: { diffReviewed: true, unrelatedFiles: [] },
  releasePlan: { repositories: [], migrationFiles: [], services: [], postDeployChecks: [{ label: 'fixture', url: 'http://127.0.0.1/health', expectedStatus: 200, contains: '' }] }
}), 'utf8')
`, 'utf8')
  await chmod(fakeCodex, 0o755)

  const previousStack = process.env.CODEX_REPOS_CONSOLE
  process.env.CODEX_REPOS_CONSOLE = repository
  const store = new TaskStore(dataDirectory)
  try {
    await store.ensureReady()
    store.transaction(() => {
      for (const task of getSeedTasks()) store.insertTask(task)
    })
    store.enqueueAgentRun('RUN-CHECKS-1', 'BUG-1049', 'manual')
    const run = store.claimNextAgentRun()

    const worker = new CodexWorker({
      store,
      rootDirectory: root,
      dataDirectory,
      uploadsDirectory,
      targetRepository: repository,
      worktreesDirectory,
      codexBinary: fakeCodex,
      buildNumber: 'checks-test-build',
      timeoutMs: 10_000,
    })
    await worker.processRun(run)

    const jobDirectory = path.join(worktreesDirectory, 'bug-1049')
    assert.equal(
      await readFile(path.join(jobDirectory, 'gba_console', 'node_modules', 'marker.txt'), 'utf8'),
      'dependency\n',
    )

    const prompt = await readFile(path.join(jobDirectory, 'prompt.txt'), 'utf8')
    assert.match(prompt, /npx tsc --noEmit/)
    assert.match(prompt, /npx vitest run --silent/)
    assert.match(prompt, /мережі немає/)

    const linkPath = path.join(jobDirectory, 'gba_console', 'node_modules')
    assert.equal((await lstat(linkPath)).isSymbolicLink(), false)
    assert.notEqual(
      (await stat(path.join(linkPath, 'marker.txt'))).ino,
      (await stat(path.join(repository, 'node_modules', 'marker.txt'))).ino,
    )
    assert.equal(store.findAgentRun(run.id).status, 'needs_review')
    assert.equal(store.findAgentRun(run.id).releaseStatus, 'blocked')
    assert.match(store.findAgentRun(run.id).releaseError, /змістовного перегляду/)
    assert.match(store.findAgentRun(run.id).summary, /фактичний git diff порожній/)

    await rm(linkPath, { recursive: true, force: true })
    execFileSync('cp', ['-al', '--', path.join(repository, 'node_modules'), linkPath])
    assert.equal(
      (await stat(path.join(linkPath, 'marker.txt'))).ino,
      (await stat(path.join(repository, 'node_modules', 'marker.txt'))).ino,
      'fixture справді відтворює старий небезпечний hardlink clone',
    )
    await worker.ensureWorktrees('BUG-1049', worker.resolveProjectStack('console'))
    assert.notEqual(
      (await stat(path.join(linkPath, 'marker.txt'))).ino,
      (await stat(path.join(repository, 'node_modules', 'marker.txt'))).ino,
      'старий hardlink clone має бути rematerialized ізольовано',
    )

    const decoy = path.join(root, 'decoy-node-modules')
    await mkdir(decoy, { recursive: true })
    await rm(linkPath, { recursive: true, force: true })
    await symlink(decoy, linkPath, 'dir')
    await worker.ensureWorktrees('BUG-1049', worker.resolveProjectStack('console'))
    assert.equal((await lstat(linkPath)).isSymbolicLink(), false)
    assert.notEqual(
      (await stat(path.join(linkPath, 'marker.txt'))).ino,
      (await stat(path.join(repository, 'node_modules', 'marker.txt'))).ino,
    )
  } finally {
    if (previousStack === undefined) delete process.env.CODEX_REPOS_CONSOLE
    else process.env.CODEX_REPOS_CONSOLE = previousStack
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
