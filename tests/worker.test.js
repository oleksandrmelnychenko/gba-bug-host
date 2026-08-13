import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexWorker, normalizeWorkerConcurrency, terminateProcessTree } from '../server/codex-worker.js'
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

test('Codex worker обмежує конфігурацію трьома паралельними агентами', () => {
  assert.equal(normalizeWorkerConcurrency(undefined), 3)
  assert.equal(normalizeWorkerConcurrency('2'), 2)
  assert.equal(normalizeWorkerConcurrency('3'), 3)
  assert.equal(normalizeWorkerConcurrency('20'), 3)
  assert.equal(normalizeWorkerConcurrency('invalid'), 3)
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

test('Codex worker одночасно обробляє три задачі й добирає наступну після звільнення слота', async () => {
  const queue = Array.from({ length: 5 }, (_, index) => ({
    id: `RUN-PARALLEL-${index + 1}`,
    taskId: `BUG-PARALLEL-${index + 1}`,
  }))
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
  await waitFor(() => started.length === 3)
  assert.deepEqual(started, ['RUN-PARALLEL-1', 'RUN-PARALLEL-2', 'RUN-PARALLEL-3'])
  assert.equal(maximumActive, 3)
  assert.equal(worker.activeRuns.size, 3)

  releases.get('RUN-PARALLEL-2')()
  await waitFor(() => started.length === 4)
  assert.equal(started[3], 'RUN-PARALLEL-4')
  assert.equal(maximumActive, 3)

  for (const runId of started) releases.get(runId)?.()
  await waitFor(() => started.length === 5)
  releases.get('RUN-PARALLEL-5')()
  await waitFor(() => worker.activeRuns.size === 0)
  assert.equal(maximumActive, 3)
  await worker.stop()
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
  tests: ['fixture test'],
  changedFiles: ['app.txt'],
  reviewedAttachments: ['proof.png', 'walkthrough.mp4', 'missing.mov — недоступне'],
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
      staffComments: 'Внутрішній коментар команди — не показувати Codex.',
      reviewComment: 'Після першого виправлення пошук усе ще падає на порожньому рядку.',
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
    assert.equal(Object.hasOwn(queued.run.inputSnapshot, 'staffComments'), false)
    store.patch('BUG-1051', { reviewComment: 'Це новіший коментар, який не належить RUN-TEST-1.' })
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
    assert.equal(schema.properties.reviewedAttachments.type, 'array')
    await assert.rejects(readFile(path.join(dataDirectory, 'agent-runs', 'result-schema.json'), 'utf8'), /ENOENT/)
    assert.equal(await readFile(path.join(worktreesDirectory, 'bug-1051', 'target', 'app.txt'), 'utf8'), 'after\n')
    const prompt = await readFile(path.join(worktreesDirectory, 'bug-1051', 'prompt.txt'), 'utf8')
    assert.match(prompt, /Після першого виправлення пошук усе ще падає на порожньому рядку/)
    assert.match(prompt, /Статус задачі на момент запуску: new/)
    assert.match(prompt, /proof\.png.*image\/png/)
    assert.match(prompt, /walkthrough\.mp4.*video\/mp4/)
    assert.match(prompt, /missing\.mov.*ФАЙЛ НЕДОСТУПНИЙ/)
    assert.match(prompt, /Відкрий кожне доступне вкладення/)
    assert.match(prompt, /створи НОВУ forward-only міграцію/)
    assert.match(prompt, /release-worker сам застосує штатний migrator/)
    assert.doesNotMatch(prompt, /Внутрішній коментар команди/)
    assert.doesNotMatch(prompt, /Це новіший коментар, який не належить RUN-TEST-1/)
    assert.deepEqual(
      JSON.parse(result.details).reviewedAttachments,
      ['proof.png', 'walkthrough.mp4', 'missing.mov — недоступне'],
    )
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
writeFileSync(outputPath, JSON.stringify({
  outcome: 'fixed',
  summary: \`Виправлення \${count} готове.\`,
  tests: ['fixture test'],
  changedFiles: ['app.txt'],
  reviewedAttachments: [],
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
  tests: ['fixture test'],
  changedFiles: ['frontend/app.txt', 'backend/app.txt'],
  reviewedAttachments: [],
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
  git(repository, 'add', 'app.txt')
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
  tests: ['npx tsc --noEmit'],
  changedFiles: [],
  reviewedAttachments: [],
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
    assert.match(store.findAgentRun(run.id).summary, /автоматичний released заборонено/)

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
