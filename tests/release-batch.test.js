import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MainlineGateCache, ReleaseWorker } from '../server/release-worker.js'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-release-batch-'))
  const origin = path.join(root, 'origin.git')
  const main = path.join(root, 'main')
  const worktrees = path.join(root, 'worktrees')
  git(root, 'init', '--bare', '-b', 'main', origin)
  git(root, 'clone', origin, main)
  git(main, 'config', 'user.email', 'release-test@example.com')
  git(main, 'config', 'user.name', 'Release Test')
  await writeFile(path.join(main, 'gate.mjs'), "import { existsSync } from 'node:fs'\nprocess.exit(existsSync('poison.txt') ? 1 : 0)\n", 'utf8')
  await writeFile(path.join(main, 'base.txt'), 'base\n', 'utf8')
  git(main, 'add', '.')
  git(main, 'commit', '-m', 'base')
  git(main, 'push', 'origin', 'HEAD:refs/heads/main')
  git(main, 'fetch', 'origin')
  const addTask = async (taskId, file, content) => {
    const worktree = path.join(worktrees, taskId.toLowerCase(), 'repo')
    await mkdir(path.dirname(worktree), { recursive: true })
    git(main, 'worktree', 'add', '-b', `codex/qa-${taskId.toLowerCase()}`, worktree, 'origin/main')
    git(worktree, 'config', 'user.email', 'codex@example.com')
    git(worktree, 'config', 'user.name', 'Codex')
    await writeFile(path.join(worktree, file), content, 'utf8')
    return {
      id: taskId,
      title: `Task ${taskId}`,
      status: 'in_progress',
      notes: '',
      agentRun: {
        id: `RUN-${taskId}`,
        status: 'completed',
        releaseStatus: 'pending',
        releaseAttempts: 0,
        releaseRepositories: [],
        releaseEvidence: {},
        details: JSON.stringify({
          releasePlan: {
            repositories: ['repo'],
            migrationFiles: [],
            services: ['svc'],
            postDeployChecks: [{ label: 'health', url: 'http://127.0.0.1/health', expectedStatus: 200, contains: '' }],
          },
        }),
      },
    }
  }
  const worker = new ReleaseWorker({
    deskBaseUrl: 'http://127.0.0.1:9',
    mainlineSource: 'origin',
    worktreesDirectory: worktrees,
    buildWorktreesDirectory: path.join(root, 'build'),
    probeWorktreesDirectory: path.join(root, 'probe'),
    batchWorktreesDirectory: path.join(root, 'batch'),
    mainlineGateCache: new MainlineGateCache(),
    repoPlan: { repo: { branch: 'main', root: main, services: ['svc'], checks: [['node', 'gate.mjs']] } },
  })
  const record = { updates: [], annotations: [], comments: [], deployed: [] }
  worker.updateRelease = async (task, values) => {
    record.updates.push({ taskId: task.id, ...values })
    task.agentRun = {
      ...task.agentRun,
      ...(values.status !== undefined ? { releaseStatus: values.status } : {}),
      ...(values.attempts !== undefined ? { releaseAttempts: values.attempts } : {}),
      ...(values.evidence !== undefined ? { releaseEvidence: values.evidence } : {}),
      ...(values.error !== undefined ? { releaseError: values.error } : {}),
    }
    if (values.taskStatus) task.status = values.taskStatus
  }
  worker.annotate = async (_task, line) => record.annotations.push(line)
  worker.comment = async (_task, body) => record.comments.push(body)
  worker.deployAndFinalize = async (entries, repos, repositoryEvidence) => {
    record.deployed.push({ taskIds: entries.map((entry) => entry.task.id), repos, repositoryEvidence, entries })
  }
  return { root, origin, main, worker, record, addTask }
}

test('пакет задач проходить один гейт і один push, а бісекція знаходить винуватця', async () => {
  const { root, origin, worker, record, addTask } = await fixture()
  try {
    const first = await addTask('BUG-A', 'a.txt', 'a\n')
    const poison = await addTask('BUG-B', 'poison.txt', 'boom\n')
    const third = await addTask('BUG-C', 'c.txt', 'c\n')

    assert.deepEqual(worker.batchCandidates([first, poison, third]).map((task) => task.id), ['BUG-A', 'BUG-B', 'BUG-C'])
    await worker.releaseGroup([first, poison, third])

    assert.equal(record.deployed.length, 0)
    assert.equal(poison.agentRun.releaseStatus, 'retrying')
    assert.equal(poison.agentRun.releaseAttempts, 1)
    assert.match(poison.agentRun.releaseError, /бісекція пакета показала/)
    assert.equal(first.agentRun.releaseStatus, 'pending')
    assert.equal(third.agentRun.releaseStatus, 'pending')
    assert.equal(worker.batchExcluded.has('BUG-B'), true)
    assert.deepEqual(worker.batchCandidates([first, poison, third]).map((task) => task.id), ['BUG-A', 'BUG-C'])

    await worker.releaseGroup([first, third])
    assert.equal(record.deployed.length, 1)
    assert.deepEqual(record.deployed[0].taskIds, ['BUG-A', 'BUG-C'])
    const published = git(origin, 'rev-parse', 'refs/heads/main')
    assert.equal(record.deployed[0].repositoryEvidence.repo.commit, published)
    const tree = git(origin, 'ls-tree', '--name-only', 'refs/heads/main')
    assert.match(tree, /a\.txt/)
    assert.match(tree, /c\.txt/)
    assert.doesNotMatch(tree, /poison\.txt/)
    assert.deepEqual(record.deployed[0].entries[0].evidence.batch.taskIds, ['BUG-A', 'BUG-C'])
    assert.deepEqual(record.deployed[0].entries[1].evidence.repositories.repo.files, ['c.txt'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('червоний mainline у пакеті ставить усі задачі на hold без зарахування спроб', async () => {
  const { root, main, worker, record, addTask } = await fixture()
  try {
    await writeFile(path.join(main, 'poison.txt'), 'main is red\n', 'utf8')
    git(main, 'add', 'poison.txt')
    git(main, 'commit', '-m', 'red main')
    git(main, 'push', 'origin', 'HEAD:refs/heads/main')
    const first = await addTask('BUG-D', 'd.txt', 'd\n')
    const second = await addTask('BUG-E', 'e.txt', 'e\n')
    await worker.releaseGroup([first, second])
    assert.equal(record.deployed.length, 0)
    assert.equal(first.agentRun.releaseStatus, 'waiting_mainline')
    assert.equal(second.agentRun.releaseStatus, 'waiting_mainline')
    assert.equal(first.agentRun.releaseAttempts, 0)
    assert.equal(record.comments.filter((body) => body.startsWith('[конвеєр:waiting-mainline]')).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('задача, що конфліктує в пакеті, виключається і йде окремо', async () => {
  const { root, worker, record, addTask } = await fixture()
  try {
    const first = await addTask('BUG-F', 'shared.txt', 'first\n')
    const second = await addTask('BUG-G', 'shared.txt', 'second\n')
    const third = await addTask('BUG-H', 'h.txt', 'h\n')
    await worker.releaseGroup([first, second, third])
    assert.equal(worker.batchExcluded.has('BUG-G'), true)
    assert.equal(record.deployed.length, 1)
    assert.deepEqual(record.deployed[0].taskIds, ['BUG-F', 'BUG-H'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
