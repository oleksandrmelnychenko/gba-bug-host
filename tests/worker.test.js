import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexWorker } from '../server/codex-worker.js'
import { TaskStore } from '../server/store.js'

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
writeFileSync('app.txt', 'after\\n', 'utf8')
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
    assert.equal(await readFile(path.join(worktreesDirectory, 'bug-1051', 'app.txt'), 'utf8'), 'after\n')
    assert.equal(await readFile(path.join(targetRepository, 'app.txt'), 'utf8'), 'before\n')
    assert.equal(git(targetRepository, 'status', '--short'), '')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
