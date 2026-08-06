import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexWorker } from '../server/codex-worker.js'
import { TaskStore, getSeedTasks } from '../server/store.js'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

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
writeFileSync('target/app.txt', 'after\\n', 'utf8')
writeFileSync(outputPath, JSON.stringify({
  outcome: 'fixed',
  summary: 'Тестове виправлення готове.',
  tests: ['fixture test'],
  changedFiles: ['app.txt']
}), 'utf8')
`, 'utf8')
  await chmod(fakeCodex, 0o755)

  const store = new TaskStore(dataDirectory)
  try {
    await store.ensureReady()
    store.transaction(() => {
      for (const task of getSeedTasks()) store.insertTask(task)
    })
    const queued = store.enqueueAgentRun('RUN-TEST-1', 'BUG-1051', 'manual')
    assert.equal(queued.created, true)
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
    assert.equal(store.find('BUG-1051').status, 'ready_for_retest')
    assert.equal(store.currentBuild('worker-test-build').bugs[0].source, 'codex')
    assert.equal(await readFile(path.join(worktreesDirectory, 'bug-1051', 'target', 'app.txt'), 'utf8'), 'after\n')
    assert.equal(await readFile(path.join(targetRepository, 'app.txt'), 'utf8'), 'before\n')
    assert.equal(git(targetRepository, 'status', '--short'), '')
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
  changedFiles: ['frontend/app.txt', 'backend/app.txt']
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
