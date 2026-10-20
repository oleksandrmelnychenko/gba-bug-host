import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  CodexWorker,
  buildPrompt,
  fixedResultQualityFailures,
  liveVerificationQualityFailures,
} from '../server/codex-worker.js'
import { TaskStore, getSeedTasks } from '../server/store.js'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

const baseResult = {
  summary: 'Готово.',
  rootCause: 'Fixture доводить точну причину дефекту.',
  acceptanceEvidence: [{ criterion: 'Сценарій', evidence: 'PASS regression', status: 'met' }],
  referenceEvidence: ['target/app.txt — current contract'],
  tests: ['PASS regression'],
  reviewedAttachments: [],
  attachmentEvidence: [],
  reviewedComments: [],
  commentEvidence: [],
  scopeReview: { diffReviewed: true, unrelatedFiles: [] },
  liveVerification: { specPath: '.qa-desk/verify/BUG-1051.json', reproducedBeforeFix: 'reproduced', evidence: 'GET показав папку' },
  blocker: '',
}

const liveSpec = (taskId) => ({
  task: taskId,
  scenario: 'Пошук клієнта повертає реальних клієнтів без синтетичної папки',
  checks: [{
    label: 'пошук клієнта',
    api: 'concord',
    path: '/api/v1/uk/clients/get/search?value=alpha',
    expectStatus: 200,
    assertions: [{ path: '$.Body[*].IsFolder', op: 'eq', value: false }],
  }],
})

async function setupWorker({ results, verificationRunner, model = 'gpt-6-astra' }) {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-codex-live-'))
  const targetRepository = path.join(root, 'target')
  const dataDirectory = path.join(root, 'data')
  const uploadsDirectory = path.join(root, 'uploads')
  const worktreesDirectory = path.join(root, 'worktrees')
  const fakeCodex = path.join(root, 'fake-codex.mjs')
  const resultsFile = path.join(root, 'results.json')
  await mkdir(targetRepository, { recursive: true })
  await mkdir(uploadsDirectory, { recursive: true })
  git(targetRepository, 'init')
  git(targetRepository, 'config', 'user.email', 'worker-test@example.com')
  git(targetRepository, 'config', 'user.name', 'Worker Test')
  await writeFile(path.join(targetRepository, 'app.txt'), 'before\n', 'utf8')
  git(targetRepository, 'add', 'app.txt')
  git(targetRepository, 'commit', '-m', 'Initial fixture')
  await writeFile(resultsFile, JSON.stringify(results), 'utf8')
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const outputPath = args[args.indexOf('--output-last-message') + 1]
const historyPath = 'codex-invocations.jsonl'
const count = existsSync(historyPath) ? readFileSync(historyPath, 'utf8').trim().split('\\n').filter(Boolean).length + 1 : 1
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
appendFileSync(historyPath, JSON.stringify(args) + '\\n', 'utf8')
writeFileSync('prompt-' + count + '.txt', prompt, 'utf8')
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'session-' + count }) + '\\n')
const step = JSON.parse(readFileSync(${JSON.stringify(resultsFile)}, 'utf8'))[count - 1]
if (step.change) appendFileSync('target/app.txt', 'change ' + count + '\\n', 'utf8')
if (step.spec) {
  mkdirSync('.qa-desk/verify', { recursive: true })
  writeFileSync('.qa-desk/verify/' + step.spec.task + '.json', JSON.stringify(step.spec), 'utf8')
}
writeFileSync(outputPath, JSON.stringify(step.result), 'utf8')
`, 'utf8')
  await chmod(fakeCodex, 0o755)
  const previousStack = process.env.CODEX_REPOS_CONSOLE
  process.env.CODEX_REPOS_CONSOLE = targetRepository
  const store = new TaskStore(dataDirectory)
  await store.ensureReady()
  store.transaction(() => {
    for (const task of getSeedTasks()) store.insertTask(task)
  })
  const worker = new CodexWorker({
    store,
    rootDirectory: root,
    dataDirectory,
    uploadsDirectory,
    targetRepository,
    worktreesDirectory,
    codexBinary: fakeCodex,
    timeoutMs: 10_000,
    model,
    verificationRunner,
  })
  return {
    store,
    worker,
    jobDirectory: (taskId) => path.join(worktreesDirectory, taskId.toLowerCase()),
    async cleanup() {
      if (previousStack === undefined) delete process.env.CODEX_REPOS_CONSOLE
      else process.env.CODEX_REPOS_CONSOLE = previousStack
      store.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const fixedResult = (overrides = {}) => ({
  ...baseResult,
  outcome: 'fixed',
  changedFiles: ['app.txt'],
  releasePlan: { repositories: ['target'], migrationFiles: [], services: [], postDeployChecks: [{ label: 'fixture', url: 'http://127.0.0.1/health', expectedStatus: 200, contains: '' }] },
  ...overrides,
})

test('quality gate вимагає live spec, а verified — ще й зелений DEV', () => {
  const missing = liveVerificationQualityFailures({ outcome: 'fixed' }, { taskId: 'BUG-1', present: false, ok: false, errors: [] })
  assert.match(missing.join('\n'), /немає machine-checkable live spec \.qa-desk\/verify\/BUG-1\.json/)
  const invalid = liveVerificationQualityFailures({ outcome: 'fixed' }, { taskId: 'BUG-1', present: true, ok: false, errors: ['path має починатися з /api/'] })
  assert.match(invalid.join('\n'), /невалідний/)
  const red = { passed: false, infrastructure: false, checks: [{ label: 'x', request: '/api/v1/uk/x', expectStatus: 200, actualStatus: 200, passed: false, assertions: [] }] }
  assert.match(liveVerificationQualityFailures({ outcome: 'verified' }, { taskId: 'BUG-1', present: true, ok: true, live: red }).join('\n'), /verified, але live spec не проходить/)
  assert.deepEqual(liveVerificationQualityFailures({ outcome: 'fixed' }, { taskId: 'BUG-1', present: true, ok: true, live: red }), [])
  assert.deepEqual(liveVerificationQualityFailures({ outcome: 'verified' }, { taskId: 'BUG-1', present: true, ok: true, live: { ...red, infrastructure: true } }), [])
  assert.deepEqual(liveVerificationQualityFailures({ outcome: 'needs_review' }, { taskId: 'BUG-1', present: false }), [])
})

test('коментарі конвеєра видно в промпті, але вони не вимагають окремого reviewedComments', () => {
  const task = {
    id: 'BUG-1389',
    title: 'Договори клієнта',
    description: 'Не видно договорів',
    area: 'Продажі',
    priority: 'medium',
    status: 'in_progress',
    project: 'console',
    comments: [
      { id: 'qa-1', author: 'QA', body: 'Досі не видно', createdAt: '2026-10-20T08:00:00.000Z' },
      { id: 'pipe-1', author: 'Система', body: '[конвеєр:waiting-mainline] Реліз чекає зеленого mainline', createdAt: '2026-10-20T08:10:00.000Z' },
    ],
  }
  const result = {
    ...fixedResult(),
    reviewedComments: ['qa-1'],
    commentEvidence: [{ id: 'qa-1', observation: 'Підтверджує сценарій' }],
  }
  const failures = fixedResultQualityFailures(result, { actualChangedFiles: ['target/app.txt'], actualRepositories: ['target'], task })
  assert.deepEqual(failures, [])
  const prompt = buildPrompt(task, { attempt: 2, trigger: 'manual', triggerReason: 'verification_failed', reviewComment: 'FAIL: 0/1 GET-перевірок' }, [], [], [], 'контекст', {
    networkAccess: true,
    devApiProxyUrl: 'http://dev-api-proxy:8790',
    verifyCliPath: '/app/server/verification-spec.js',
    priorRunsContext: '- Спроба #1 (manual) · вердикт: completed/fixed',
  })
  assert.match(prompt, /Live-перевірка на DEV — обов’язкова частина задачі/)
  assert.match(prompt, /http:\/\/dev-api-proxy:8790\/api\/v1\/uk\/clients\/get\/top/)
  assert.match(prompt, /\.\/\.qa-desk\/verify\/BUG-1389\.json/)
  assert.match(prompt, /node \/app\/server\/verification-spec\.js/)
  assert.match(prompt, /Події конвеєра[\s\S]*waiting-mainline/)
  assert.match(prompt, /Live-перевірка після deploy не пройшла — конвеєр повернув задачу з результатами:\nFAIL: 0\/1/)
  assert.match(prompt, /Попередні рани цієї задачі[\s\S]*Спроба #1/)
  assert.match(prompt, /лише з конкретним блокером у полі blocker/)
  assert.match(prompt, /id="qa-1"/)
  assert.doesNotMatch(prompt, /id="pipe-1"/)
})

test('fixed без live spec не паркує задачу: одне авто-продовження з поясненням і коментарем конвеєра', async () => {
  const fixture = await setupWorker({
    results: [
      { change: true, result: fixedResult() },
      { change: true, result: fixedResult() },
    ],
    verificationRunner: async () => ({ passed: false, infrastructure: false, checks: [] }),
  })
  try {
    fixture.store.enqueueAgentRun('RUN-LIVE-1', 'BUG-1051', 'manual')
    await fixture.worker.processRun(fixture.store.claimNextAgentRun())
    const first = fixture.store.findAgentRun('RUN-LIVE-1')
    assert.equal(first.status, 'needs_review')
    assert.match(first.summary, /немає machine-checkable live spec/)
    const followUp = fixture.store.find('BUG-1051').agentRun
    assert.equal(followUp.status, 'queued')
    assert.equal(followUp.triggerReason, 'auto_continue')
    assert.match(followUp.reviewComment, /немає machine-checkable live spec/)
    assert.equal(fixture.store.find('BUG-1051').status, 'in_progress')
    const comments = fixture.store.commentsForTask('BUG-1051')
    assert.match(comments.at(-1).body, /^\[конвеєр:auto-continue\]/)

    await fixture.worker.processRun(fixture.store.claimNextAgentRun())
    const second = fixture.store.findAgentRun(followUp.id)
    assert.equal(second.status, 'needs_review')
    assert.equal(second.sessionMode, 'fresh')
    assert.equal(second.sessionReason, 'trigger:manual')
    assert.equal(fixture.store.find('BUG-1051').status, 'blocked')
    assert.equal(fixture.store.find('BUG-1051').agentRun.id, second.id)
    assert.match(fixture.store.commentsForTask('BUG-1051').at(-1).body, /^\[конвеєр:needs_review\]/)
    const prompt = await readFile(path.join(fixture.jobDirectory('BUG-1051'), 'prompt-2.txt'), 'utf8')
    assert.match(prompt, /Конвеєр повернув задачу, бо попередня спроба не дійшла до доведеного результату/)
    assert.match(prompt, /Попередні рани цієї задачі[\s\S]*Спроба #1/)
  } finally {
    await fixture.cleanup()
  }
})

test('fixed з валідним spec завершується, а pre-deploy прогін і модель зберігаються в run', async () => {
  const calls = []
  const fixture = await setupWorker({
    results: [{ change: true, spec: liveSpec('BUG-1051'), result: fixedResult() }],
    verificationRunner: async (spec, options) => {
      calls.push({ spec, options })
      return { passed: false, infrastructure: false, startedAt: '', finishedAt: '', checks: [{ label: 'пошук клієнта', request: spec.checks[0].path, expectStatus: 200, actualStatus: 200, passed: false, assertions: [{ op: 'eq', path: '$.Body[*].IsFolder', expected: false, actual: '1/1 не відповідають: [true]', passed: false }] }] }
    },
  })
  try {
    fixture.store.enqueueAgentRun('RUN-LIVE-2', 'BUG-1051', 'manual')
    await fixture.worker.processRun(fixture.store.claimNextAgentRun())
    const run = fixture.store.findAgentRun('RUN-LIVE-2')
    const details = JSON.parse(run.details)
    assert.equal(run.status, 'completed')
    assert.equal(run.codexModel, 'gpt-6-astra')
    assert.equal(run.sessionMode, 'fresh')
    assert.equal(run.sessionReason, 'first-run')
    assert.equal(Object.keys(run.baselineCommits)[0], 'target')
    assert.equal(run.headCommits.target.dirty, true)
    assert.equal(details.contractVersion, 2)
    assert.equal(details.verification.valid, true)
    assert.equal(details.verification.spec.checks[0].path, '/api/v1/uk/clients/get/search?value=alpha')
    assert.equal(details.verification.preDeploy.passed, false)
    assert.match(details.verification.preDeploy.report, /FAIL/)
    assert.equal(calls[0].options.proxyBaseUrl, 'http://dev-api-proxy:8790')
    assert.equal(fixture.store.find('BUG-1051').status, 'in_progress')
    assert.equal(fixture.store.commentsForTask('BUG-1051').length, 0)
  } finally {
    await fixture.cleanup()
  }
})

test('needs_review з конкретним блокером одразу блокує задачу й пише коментар із блокером', async () => {
  const blocker = 'DEV API proxy повертає 503 credential на GET /api/v1/uk/clients/get/top; потрібен робочий proxy'
  const fixture = await setupWorker({
    results: [{
      result: {
        ...baseResult,
        outcome: 'needs_review',
        changedFiles: [],
        blocker,
        releasePlan: { repositories: [], migrationFiles: [], services: [], postDeployChecks: [{ label: 'x', url: 'http://127.0.0.1/health', expectedStatus: 200, contains: '' }] },
      },
    }],
    verificationRunner: async () => ({ passed: true, checks: [] }),
  })
  try {
    fixture.store.enqueueAgentRun('RUN-LIVE-3', 'BUG-1051', 'manual')
    await fixture.worker.processRun(fixture.store.claimNextAgentRun())
    assert.equal(fixture.store.findAgentRun('RUN-LIVE-3').status, 'needs_review')
    assert.equal(fixture.store.find('BUG-1051').status, 'blocked')
    assert.equal(fixture.store.find('BUG-1051').agentRun.id, 'RUN-LIVE-3')
    const comment = fixture.store.commentsForTask('BUG-1051').at(-1)
    assert.match(comment.body, /^\[конвеєр:needs_review\]/)
    assert.ok(comment.body.includes(blocker))
  } finally {
    await fixture.cleanup()
  }
})

test('needs_review без конкретного блокера автоматично продовжується', async () => {
  const fixture = await setupWorker({
    results: [{
      result: {
        ...baseResult,
        outcome: 'needs_review',
        changedFiles: [],
        blocker: 'немає доступу',
        releasePlan: { repositories: [], migrationFiles: [], services: [], postDeployChecks: [{ label: 'x', url: 'http://127.0.0.1/health', expectedStatus: 200, contains: '' }] },
      },
    }],
    verificationRunner: async () => ({ passed: true, checks: [] }),
  })
  try {
    fixture.store.enqueueAgentRun('RUN-LIVE-4', 'BUG-1051', 'manual')
    await fixture.worker.processRun(fixture.store.claimNextAgentRun())
    const next = fixture.store.find('BUG-1051').agentRun
    assert.equal(next.triggerReason, 'auto_continue')
    assert.match(next.reviewComment, /без конкретного блокера/)
  } finally {
    await fixture.cleanup()
  }
})

test('швидкий review-again після completed продовжує сесію, а зміна моделі стартує свіжу з підсумком', async () => {
  const fixture = await setupWorker({
    results: [
      { change: true, spec: liveSpec('BUG-1051'), result: fixedResult() },
      { change: true, spec: liveSpec('BUG-1051'), result: fixedResult() },
      { change: true, spec: liveSpec('BUG-1051'), result: fixedResult() },
    ],
    verificationRunner: async () => ({ passed: true, checks: [] }),
  })
  try {
    fixture.store.enqueueAgentRun('RUN-S-1', 'BUG-1051', 'manual')
    await fixture.worker.processRun(fixture.store.claimNextAgentRun())
    fixture.store.updateAgentRunRelease('RUN-S-1', { status: 'released', phase: 'released' }, 'ready_for_retest')
    fixture.store.patch('BUG-1051', { status: 'review_again', reviewComment: 'Ще одна дрібниця в підписі.' })
    fixture.store.enqueueAgentRun('RUN-S-2', 'BUG-1051', 'review_again')
    await fixture.worker.processRun(fixture.store.claimNextAgentRun())
    const second = fixture.store.findAgentRun('RUN-S-2')
    assert.equal(second.sessionMode, 'resume')
    assert.equal(second.sessionReason, 'quick-follow-up')

    fixture.store.updateAgentRunRelease('RUN-S-2', { status: 'released', phase: 'released' }, 'ready_for_retest')
    fixture.worker.model = 'gpt-6-sol'
    fixture.store.patch('BUG-1051', { status: 'review_again', reviewComment: 'Перевір ще раз після зміни моделі.' })
    fixture.store.enqueueAgentRun('RUN-S-3', 'BUG-1051', 'review_again')
    await fixture.worker.processRun(fixture.store.claimNextAgentRun())
    const third = fixture.store.findAgentRun('RUN-S-3')
    assert.equal(third.sessionMode, 'fresh')
    assert.equal(third.sessionReason, 'model-changed:gpt-6-astra->gpt-6-sol')
    assert.equal(third.codexModel, 'gpt-6-sol')

    const invocations = (await readFile(path.join(fixture.jobDirectory('BUG-1051'), 'codex-invocations.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(invocations[1].includes('resume'), true)
    assert.equal(invocations[1].includes('session-1'), true)
    assert.equal(invocations[2].includes('resume'), false)
    const resumedPrompt = await readFile(path.join(fixture.jobDirectory('BUG-1051'), 'prompt-2.txt'), 'utf8')
    const freshPrompt = await readFile(path.join(fixture.jobDirectory('BUG-1051'), 'prompt-3.txt'), 'utf8')
    assert.doesNotMatch(resumedPrompt, /Попередні рани цієї задачі/)
    assert.match(freshPrompt, /Попередні рани цієї задачі[\s\S]*Спроба #1[\s\S]*Спроба #2/)
  } finally {
    await fixture.cleanup()
  }
})

test('ліміт Codex не валить задачу: запуск повертається в чергу, worker стає на паузу з backoff', async () => {
  const { isUsageLimitFailure, usageLimitBackoffMs, USAGE_LIMIT_STATE_KEY } = await import('../server/codex-worker.js')
  assert.equal(isUsageLimitFailure("You've hit your usage limit. Try again at 08:00."), true)
  assert.equal(isUsageLimitFailure('tests failed'), false)
  assert.equal(usageLimitBackoffMs(1), 15 * 60 * 1000)
  assert.equal(usageLimitBackoffMs(2), 30 * 60 * 1000)
  assert.equal(usageLimitBackoffMs(10), 2 * 60 * 60 * 1000)

  const fixture = await setupWorker({ results: [], verificationRunner: async () => ({ passed: true, checks: [] }) })
  try {
    const failing = path.join(path.dirname(fixture.jobDirectory('BUG-1051')), '..', 'limit-codex.mjs')
    await writeFile(failing, `#!/usr/bin/env node
for await (const chunk of process.stdin) void chunk
process.stdout.write(JSON.stringify({ type: 'error', message: "You've hit your usage limit. Try again at 08:00." }) + '\\n')
process.exit(1)
`, 'utf8')
    await chmod(failing, 0o755)
    fixture.worker.codexBinary = failing
    fixture.store.enqueueAgentRun('RUN-LIMIT', 'BUG-1051', 'manual')
    await fixture.worker.processRun(fixture.store.claimNextAgentRun(fixture.worker.workerId))
    const run = fixture.store.findAgentRun('RUN-LIMIT')
    assert.equal(run.status, 'queued')
    assert.match(run.error, /Ліміт Codex/)
    assert.ok(fixture.worker.pausedUntil > Date.now())
    assert.ok(fixture.store.readSystemState(USAGE_LIMIT_STATE_KEY).pausedUntil)
    let claimed = 0
    fixture.store.claimNextAgentRun = () => {
      claimed += 1
      return null
    }
    fixture.worker.tick()
    assert.equal(claimed, 0, 'під час паузи нові запуски не беруться')
  } finally {
    await fixture.cleanup()
  }
})

test('SQL-задача запускається з підвищеним reasoning effort, урок зберігається для наступних запусків', async () => {
  const fixture = await setupWorker({
    results: [{ change: true, spec: liveSpec('BUG-1051'), result: fixedResult({ lesson: 'Звіти по складу рахують залишок лише з повного руху, а не з кешованої таблиці' }) }],
    verificationRunner: async () => ({ passed: true, checks: [] }),
  })
  try {
    fixture.store.patch('BUG-1051', { title: 'Повільний SQL у звіті залишків' })
    fixture.store.enqueueAgentRun('RUN-EFFORT', 'BUG-1051', 'manual')
    await fixture.worker.processRun(fixture.store.claimNextAgentRun())
    const run = fixture.store.findAgentRun('RUN-EFFORT')
    assert.equal(run.reasoningEffort, 'xhigh')
    assert.equal(run.reasoningReason, 'sql')
    const invocation = JSON.parse((await readFile(path.join(fixture.jobDirectory('BUG-1051'), 'codex-invocations.jsonl'), 'utf8')).trim())
    assert.equal(invocation.includes('model_reasoning_effort="xhigh"'), true)
    assert.match(fixture.store.readSystemState('codex-lessons').items[0].text, /повного руху/)

    fixture.store.updateAgentRunRelease('RUN-EFFORT', { status: 'released', phase: 'released' }, 'ready_for_retest')
    fixture.store.patch('BUG-1050', { status: 'new' })
    fixture.store.enqueueAgentRun('RUN-NEXT', 'BUG-1050', 'manual')
    const next = fixture.store.claimNextAgentRun()
    const context = await fixture.worker.persistentContextForRun(fixture.store.find('BUG-1050'), next)
    assert.match(context, /Уроки попередніх задач[\s\S]*повного руху/)
  } finally {
    await fixture.cleanup()
  }
})

test('Codex worker із concurrency=2 запускає дві незалежні задачі одночасно', async () => {
  const queue = [{ id: 'R1', taskId: 'T1' }, { id: 'R2', taskId: 'T2' }, { id: 'R3', taskId: 'T3' }]
  const store = {
    claimNextAgentRun: () => queue.shift() ?? null,
    claimNextCleanupRun: () => null,
    updateAgentRun: () => undefined,
  }
  const worker = new CodexWorker({ store, rootDirectory: '/tmp', dataDirectory: '/tmp', uploadsDirectory: '/tmp', concurrency: 2 })
  const releases = new Map()
  let maximumActive = 0
  let active = 0
  worker.processRun = async (run) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => releases.set(run.id, resolve))
    active -= 1
  }
  worker.tick()
  assert.equal(worker.activeRuns.size, 2)
  releases.get('R1')()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(worker.activeRuns.size, 2)
  releases.get('R2')()
  releases.get('R3')()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(maximumActive, 2)
  worker.acceptingRuns = false
})

test('структуровані вхідні дані QA і знімок «до» потрапляють у промпт', () => {
  const prompt = buildPrompt({
    id: 'BUG-1391',
    title: 'Ціна товару',
    description: 'Не та ціна',
    area: 'Товари',
    priority: 'medium',
    status: 'new',
    project: 'console',
    entityKind: 'product',
    entityCode: '1987302814-BOSCH',
    expectedResult: 'Ціна 12.40 EUR',
    actualResult: 'Ціна 0',
    intakeEvidence: { requests: [{ path: '/api/v1/uk/products/search/advanced?value=1987302814-BOSCH', status: 200, count: 1 }] },
  }, { attempt: 1, trigger: 'manual' }, [], [], [], 'контекст', { networkAccess: true })
  assert.match(prompt, /Зачеплена сутність: товар "1987302814-BOSCH"/)
  assert.match(prompt, /Очікувано \(QA\): Ціна 12\.40 EUR/)
  assert.match(prompt, /Фактично \(QA\): Ціна 0/)
  assert.match(prompt, /Знімок «до» на DEV[\s\S]*products\/search\/advanced/)
})

test('UI spec від Codex зберігається для release-worker, а невалідний зупиняє реліз', async () => {
  const uiSpec = { name: 'bug-1051-ui', url: '/clients', checks: [{ type: 'text', text: 'KD02801' }] }
  const fixture = await setupWorker({
    results: [
      { change: true, spec: liveSpec('BUG-1051'), result: fixedResult() },
    ],
    verificationRunner: async () => ({ passed: true, checks: [] }),
  })
  try {
    const { mkdir: makeDirectory, writeFile: write } = await import('node:fs/promises')
    const job = fixture.jobDirectory('BUG-1051')
    await makeDirectory(path.join(job, '.qa-desk', 'verify'), { recursive: true })
    await write(path.join(job, '.qa-desk', 'verify', 'BUG-1051.ui.json'), JSON.stringify(uiSpec), 'utf8')
    fixture.store.enqueueAgentRun('RUN-UI-1', 'BUG-1051', 'manual')
    await fixture.worker.processRun(fixture.store.claimNextAgentRun())
    const details = JSON.parse(fixture.store.findAgentRun('RUN-UI-1').details)
    assert.equal(fixture.store.findAgentRun('RUN-UI-1').status, 'completed')
    assert.equal(details.verification.uiSpec.url, '/clients')
    assert.equal(details.verification.uiSpec.env, 'dev')

    await write(path.join(job, '.qa-desk', 'verify', 'BUG-1051.ui.json'), JSON.stringify({ ...uiSpec, allowNonGet: ['/save$'] }), 'utf8')
    const { liveVerificationQualityFailures } = await import('../server/codex-worker.js')
    const failures = liveVerificationQualityFailures({ outcome: 'fixed' }, { taskId: 'BUG-1051', present: true, ok: true, ui: { present: true, ok: false, errors: ['UI spec: allowNonGet заборонений — UI-перевірка лише читає'] } })
    assert.match(failures.join(' '), /BUG-1051\.ui\.json невалідний/)
  } finally {
    await fixture.cleanup()
  }
})
