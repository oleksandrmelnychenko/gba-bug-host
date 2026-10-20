import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MAX_VERIFICATION_ATTEMPTS,
  MainlineGateCache,
  ReleaseWorker,
  extractFailingTests,
  mainlineGateKey,
  mainlineRecoveryCandidate,
  relatedTestCheck,
  selectReleasableTasks,
} from '../server/release-worker.js'

const shaA = 'a'.repeat(40)
const shaB = 'b'.repeat(40)
const gate = ['verify', 'gate']

async function withWorker(run, { verifyCode = () => 1, mainline = () => shaA, ...options } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-release-live-'))
  const calls = []
  const worker = new ReleaseWorker({
    deskBaseUrl: 'http://127.0.0.1:9',
    worktreesDirectory: path.join(root, 'worktrees'),
    probeWorktreesDirectory: path.join(root, 'probe'),
    mainlineGateCache: new MainlineGateCache(),
    repoPlan: {
      repo: { branch: 'main', root: path.join(root, 'main'), services: ['svc'], checks: [gate, ['build']] },
    },
    verificationRetryDelayMs: 0,
    processRunner: async (command, args, processOptions = {}) => {
      calls.push({ command, args, cwd: processOptions.cwd })
      if (command === 'verify') return { code: verifyCode(processOptions.cwd), output: 'FAIL src/flaky.test.ts' }
      if (command === 'git' && args.includes('rev-parse')) return { code: 0, output: mainline() }
      return { code: 0, output: '' }
    },
    ...options,
  })
  const record = { updates: [], annotations: [], comments: [], followUps: [], reopened: [] }
  worker.updateRelease = async (task, values) => {
    record.updates.push(values)
    task.agentRun = {
      ...task.agentRun,
      ...(values.status !== undefined ? { releaseStatus: values.status } : {}),
      ...(values.phase !== undefined ? { releasePhase: values.phase } : {}),
      ...(values.attempts !== undefined ? { releaseAttempts: values.attempts } : {}),
      ...(values.evidence !== undefined ? { releaseEvidence: values.evidence } : {}),
      ...(values.error !== undefined ? { releaseError: values.error } : {}),
    }
    if (values.taskStatus) task.status = values.taskStatus
  }
  worker.annotate = async (task, line) => {
    record.annotations.push(line)
    task.notes = `${task.notes ?? ''}\n${line}`
  }
  worker.comment = async (_task, body) => record.comments.push(body)
  worker.enqueueFollowUp = async (task, reason, comment) => {
    record.followUps.push({ taskId: task.id, reason, comment })
    return true
  }
  worker.reopenRelease = async (task, values) => {
    record.reopened.push(values)
    task.agentRun = { ...task.agentRun, releaseStatus: values.status, releaseEvidence: values.evidence }
    return true
  }
  worker.cleanupReleasedWorktrees = async () => []
  worker.readConsoleBuild = async () => '2026.10.20.0900'
  try {
    await run({ worker, calls, record, root })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function gateFailure() {
  return {
    ok: false,
    kind: 'validation',
    phase: 'validating',
    reason: 'repo: перевірка «verify gate» впала; mainline не змінено',
    failedGate: { repo: 'repo', check: gate, baselineCommit: shaA },
  }
}

const humanTask = () => ({
  id: 'BUG-3001',
  title: 'Задача на червоному main',
  status: 'in_progress',
  notes: '',
  agentRun: { id: 'RUN-3001', status: 'completed', releaseAttempts: 1, releaseStatus: 'processing', releaseEvidence: {} },
})

test('червоний mainline не зараховує спробу: задача чекає з маркером, коментарем і кешем гейту', async () => {
  await withWorker(async ({ worker, calls, record }) => {
    const task = humanTask()
    await worker.handleReleaseFailure(task, gateFailure())

    assert.equal(task.agentRun.releaseStatus, 'waiting_mainline')
    assert.equal(task.agentRun.releaseAttempts, 1)
    assert.equal(task.status, 'in_progress')
    assert.equal(task.agentRun.releaseEvidence.mainlineHold.sha, shaA)
    assert.deepEqual(task.agentRun.releaseEvidence.mainlineHold.check, gate)
    assert.match(record.annotations[0], new RegExp(`^\\[release-waiting-mainline:${shaA}\\]`))
    assert.match(record.comments[0], /^\[конвеєр:waiting-mainline\]/)
    assert.equal(calls.filter((call) => call.command === 'verify').length, 1)
    assert.match(calls.find((call) => call.command === 'verify').cwd, /probe\/repo$/)
    assert.equal((await worker.mainlineGateCache.get(mainlineGateKey('repo', shaA, gate))).status, 'red')

    await worker.handleReleaseFailure(task, gateFailure())
    assert.equal(calls.filter((call) => call.command === 'verify').length, 1, 'той самий repo+SHA+gate береться з кешу')
    assert.equal(record.annotations.length, 1, 'повторна мітка на тому самому SHA не дублюється')
    assert.equal(record.comments.length, 1)
  })
})

test('зелений mainline доводить вину задачі: спроба зараховується, а після ліміту статус і коментар оновлюються одразу', async () => {
  await withWorker(async ({ worker, record }) => {
    const task = { ...humanTask(), agentRun: { ...humanTask().agentRun, releaseAttempts: 2 } }
    await worker.handleReleaseFailure(task, gateFailure())

    assert.equal(task.agentRun.releaseStatus, 'blocked')
    assert.equal(task.agentRun.releaseAttempts, 3)
    assert.equal(task.status, 'blocked')
    assert.equal(task.agentRun.releaseEvidence.failure.mainlineGate.status, 'green')
    assert.match(task.agentRun.releaseError, /гейт зелений — падіння внесла задача/)
    assert.match(record.annotations[0], /^\[release-blocked:/)
    assert.match(record.comments[0], /^\[конвеєр:blocked\]/)
  }, { verifyCode: () => 0 })
})

test('mainline-hold перевіряє лише новий SHA і відпускає задачу, коли гейт на ньому зелений', async () => {
  let current = shaA
  let mainlineGreen = false
  await withWorker(async ({ worker, calls, record }) => {
    const task = humanTask()
    await worker.handleReleaseFailure(task, gateFailure())
    assert.equal(await worker.mainlineHoldReady(task), false)
    assert.equal(calls.filter((call) => call.command === 'verify').length, 1)

    current = shaB
    assert.equal(await worker.mainlineHoldReady(task), false)
    assert.equal(task.agentRun.releaseEvidence.mainlineHold.sha, shaB)
    assert.match(record.annotations.at(-1), new RegExp(`^\\[release-waiting-mainline:${shaB}\\]`))
    assert.equal(calls.filter((call) => call.command === 'verify').length, 2)

    current = 'c'.repeat(40)
    mainlineGreen = true
    assert.equal(await worker.mainlineHoldReady(task), true)
  }, { verifyCode: () => (mainlineGreen ? 0 : 1), mainline: () => current })
})

test('червоний кеш старший за TTL перевіряється повторно на тому самому SHA', async () => {
  await withWorker(async ({ worker, calls }) => {
    await worker.mainlineGateCache.set(mainlineGateKey('repo', shaA, gate), { status: 'red', at: new Date(Date.now() - 2_000).toISOString() })
    const probe = await worker.probeMainlineGate('repo', shaA, gate)
    assert.equal(probe.status, 'green')
    assert.equal(calls.filter((call) => call.command === 'verify').length, 1)
  }, { verifyCode: () => 0, mainlineRedTtlMs: 1_000 })
})

test('кеш гейтів mainline переживає рестарт release-worker', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-gate-cache-'))
  try {
    const file = path.join(root, 'nested', 'gates.json')
    const first = new MainlineGateCache({ file, maximumEntries: 2 })
    await first.set('k1', { status: 'red', at: '2026-10-20T10:00:00.000Z' })
    await first.set('k2', { status: 'green', at: '2026-10-20T11:00:00.000Z' })
    await first.set('k3', { status: 'green', at: '2026-10-20T12:00:00.000Z' })
    const second = new MainlineGateCache({ file })
    assert.equal(await second.get('k1'), null)
    assert.equal((await second.get('k3')).status, 'green')
    assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8'))).sort(), ['k2', 'k3'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('waiting_mainline не блокує інші релізи й іде останнім у черзі', () => {
  const task = (id, releaseStatus) => ({ id, status: 'in_progress', notes: '', agentRun: { status: 'completed', releaseStatus, finishedAt: '2026-10-20T10:00:00.000Z' } })
  assert.deepEqual(
    selectReleasableTasks([task('W', 'waiting_mainline'), task('P', 'pending'), task('R', 'retrying')]).map((item) => item.id),
    ['R', 'P', 'W'],
  )
})

test('tick відпускає задачу з hold лише коли нема активних релізів, і запускає відновлення', async () => {
  const originalFetch = global.fetch
  await withWorker(async ({ worker }) => {
    const waiting = { id: 'W', status: 'in_progress', notes: '', agentRun: { status: 'completed', releaseStatus: 'waiting_mainline' } }
    const released = []
    let recovery = 0
    worker.releaseBatch = async (batch) => released.push(...batch.map((item) => item.id))
    worker.mainlineHoldReady = async () => true
    worker.recoverMainlineBlockedTasks = async () => { recovery += 1 }
    global.fetch = async () => ({ ok: true, json: async () => [waiting] })
    await worker.tick()
    assert.deepEqual(released, ['W'])

    worker.mainlineHoldReady = async () => false
    await worker.tick()
    assert.deepEqual(released, ['W'])
    assert.equal(recovery, 1)
  }, { settleMs: 0 }).finally(() => {
    global.fetch = originalFetch
  })
})

test('legacy release-blocked через тестовий гейт стає кандидатом на відновлення лише для застряглих задач', () => {
  const plan = { repo: { branch: 'main', root: '/x', services: [], checks: [gate] } }
  const blocked = (overrides = {}) => ({
    id: 'BUG-1386',
    status: 'in_progress',
    agentRun: {
      status: 'completed',
      releaseStatus: 'blocked',
      releaseError: 'repo: перевірка «verify gate» впала; mainline не змінено',
      releaseEvidence: {},
    },
    ...overrides,
  })
  assert.deepEqual(mainlineRecoveryCandidate(blocked(), plan), { repo: 'repo', check: gate })
  assert.equal(mainlineRecoveryCandidate(blocked({ status: 'ready_for_retest' }), plan), null)
  assert.equal(mainlineRecoveryCandidate(blocked({ status: 'done' }), plan), null)
  assert.equal(mainlineRecoveryCandidate({ ...blocked(), agentRun: { ...blocked().agentRun, releaseEvidence: { failure: { mainlineGate: { status: 'green' } } } } }, plan), null)
  assert.equal(mainlineRecoveryCandidate({ ...blocked(), agentRun: { ...blocked().agentRun, releaseEvidence: { mainlineRecovery: { at: 'x' } } } }, plan), null)
  assert.equal(mainlineRecoveryCandidate({ ...blocked(), agentRun: { ...blocked().agentRun, releaseError: 'repo: конфлікт мерджу' } }, plan), null)
})

test('відновлення: зелений mainline повертає задачу в реліз, червоний — у hold, обидва з коментарем', async () => {
  let green = true
  await withWorker(async ({ worker, record }) => {
    const make = (id) => ({
      id,
      status: 'in_progress',
      notes: '',
      agentRun: {
        id: `RUN-${id}`,
        status: 'completed',
        releaseStatus: 'blocked',
        releaseError: 'repo: перевірка «verify gate» впала; mainline не змінено',
        releaseEvidence: {},
      },
    })
    const first = make('BUG-1')
    await worker.recoverMainlineBlockedTasks([first])
    assert.equal(record.reopened[0].status, 'retrying')
    assert.equal(first.agentRun.releaseEvidence.mainlineRecovery.mainline, 'green')
    assert.match(record.comments[0], /^\[конвеєр:recovered\]/)
    assert.match(record.annotations[0], /^\[release-recovered:/)

    green = false
    worker.lastRecoveryAt = 0
    worker.mainlineGateCache = new MainlineGateCache()
    const second = make('BUG-2')
    await worker.recoverMainlineBlockedTasks([second])
    assert.equal(record.reopened[1].status, 'waiting_mainline')
    assert.equal(second.agentRun.releaseEvidence.mainlineHold.sha, shaA)

    await worker.recoverMainlineBlockedTasks([make('BUG-3')])
    assert.equal(record.reopened.length, 2, 'відновлення не частіше за інтервал')
  }, { verifyCode: () => (green ? 0 : 1) })
})

const specDetails = (extra = {}) => JSON.stringify({
  contractVersion: 2,
  outcome: 'verified',
  verification: {
    spec: {
      task: 'BUG-4001',
      scenario: 'Картка товару показує назву руху і номер документа',
      checks: [{
        label: 'рух товару',
        api: 'concord',
        path: '/api/v1/uk/products/movement/get?netId=4001',
        expectStatus: 200,
        assertions: [{ path: '$.Body[*].DocumentNumber', op: 'exists' }],
      }],
    },
  },
  releasePlan: { repositories: [], migrationFiles: [], services: [], postDeployChecks: [{ label: 'health', url: 'http://127.0.0.1/health', expectedStatus: 200, contains: '' }] },
  ...extra,
})

const auditTask = (details = specDetails(), trigger = 'manual') => ({
  id: 'BUG-4001',
  title: 'Audit-only',
  status: 'in_progress',
  notes: '',
  agentRun: { id: 'RUN-4001', status: 'completed', releaseAttempts: 0, releaseStatus: 'pending', triggerReason: trigger === 'verification_failed' ? 'verification_failed' : '', details },
})

const passedResult = {
  passed: true,
  infrastructure: false,
  checks: [{ label: 'рух товару', request: '/api/v1/uk/products/movement/get?netId=4001', expectStatus: 200, actualStatus: 200, passed: true, assertions: [{ op: 'exists', path: '$.Body[*].DocumentNumber', passed: true, actual: '2 знач.' }] }],
}
const failedResult = {
  passed: false,
  infrastructure: false,
  checks: [{ label: 'рух товару', request: '/api/v1/uk/products/movement/get?netId=4001', expectStatus: 200, actualStatus: 200, passed: false, assertions: [{ op: 'exists', path: '$.Body[*].DocumentNumber', passed: false, actual: 'відсутнє або null' }] }],
}

test('audit-only реліз проганяє spec проти DEV через proxy і одразу ставить ретест з доказами в коментарі', async () => {
  const runs = []
  await withWorker(async ({ worker, record }) => {
    worker.verifyPostDeployChecks = async () => ({ ok: true, evidence: [{ label: 'health', url: 'http://127.0.0.1/health', actualStatus: 200, passed: true }] })
    const task = auditTask()
    await worker.releaseBatch([task])
    assert.equal(task.agentRun.releaseStatus, 'released')
    assert.equal(task.status, 'ready_for_retest')
    assert.equal(task.agentRun.releaseEvidence.liveVerification.passed, true)
    assert.equal(runs[0].options.proxyBaseUrl, 'http://127.0.0.1:4010')
    assert.match(record.comments[0], /^\[конвеєр:released\]/)
    assert.match(record.comments[0], /Білд консолі: 2026\.10\.20\.0900/)
    assert.match(record.comments[0], /PASS: 1\/1 GET-перевірок/)
  }, {
    verificationRunner: async (spec, options) => {
      runs.push({ spec, options })
      return passedResult
    },
  })
})

test('провалена live-перевірка повертає задачу Codex з деталями і зараховує спробу', async () => {
  let attempts = 0
  await withWorker(async ({ worker, record }) => {
    worker.verifyPostDeployChecks = async () => ({ ok: true, evidence: [] })
    worker.fetchAgentRuns = async () => [{ triggerReason: '' }]
    const task = auditTask()
    await worker.releaseBatch([task])
    assert.equal(attempts, 2, 'деплойний warm-up: spec повторюється перед вироком')
    assert.equal(task.agentRun.releaseStatus, 'blocked')
    assert.equal(task.status, 'in_progress')
    assert.equal(task.agentRun.releaseEvidence.liveVerification.followUp, 'requested')
    assert.equal(record.followUps.length, 1)
    assert.equal(record.followUps[0].reason, 'verification_failed')
    assert.match(record.followUps[0].comment, /FAIL: 0\/1/)
    assert.match(record.comments[0], /^\[конвеєр:verification-failed\]/)
    assert.match(record.comments[0], /повтор 1 з 3/)
    assert.match(record.annotations.at(-1), /^\[live-verify-failed:/)
  }, {
    verificationAttempts: 2,
    verificationRunner: async () => {
      attempts += 1
      return failedResult
    },
  })
})

test(`після ${MAX_VERIFICATION_ATTEMPTS} провалених live-перевірок задача блокується без нового запуску`, async () => {
  await withWorker(async ({ worker, record }) => {
    worker.verifyPostDeployChecks = async () => ({ ok: true, evidence: [] })
    worker.fetchAgentRuns = async () => [{ triggerReason: 'verification_failed' }, { triggerReason: 'verification_failed' }, { triggerReason: '' }]
    const task = auditTask(specDetails(), 'verification_failed')
    await worker.releaseBatch([task])
    assert.equal(task.status, 'blocked')
    assert.equal(task.agentRun.releaseEvidence.liveVerification.followUp, 'exhausted')
    assert.equal(record.followUps.length, 0)
    assert.match(record.comments[0], /Ліміт 3 автоматичних повторів вичерпано/)
  }, { verificationRunner: async () => failedResult })
})

test('недоступний proxy — інфраструктура: реліз ретраїться без звинувачення задачі', async () => {
  await withWorker(async ({ worker, record }) => {
    worker.verifyPostDeployChecks = async () => ({ ok: true, evidence: [] })
    const task = auditTask()
    await worker.releaseBatch([task])
    assert.equal(task.agentRun.releaseStatus, 'retrying')
    assert.equal(record.followUps.length, 0)
    assert.match(record.annotations[0], /^\[release-retry\]/)
  }, { verificationRunner: async () => ({ passed: false, infrastructure: true, checks: [{ label: 'x', request: '/api', expectStatus: 200, actualStatus: null, passed: false, error: 'ECONNREFUSED', assertions: [] }] }) })
})

test('запуск без spec за новим контрактом не вважається перевіреним, legacy — випускається з позначкою', async () => {
  await withWorker(async ({ worker, record }) => {
    worker.verifyPostDeployChecks = async () => ({ ok: true, evidence: [] })
    worker.fetchAgentRuns = async () => []
    const modern = auditTask(JSON.stringify({ ...JSON.parse(specDetails()), verification: { spec: null } }))
    await worker.releaseBatch([modern])
    assert.equal(modern.agentRun.releaseStatus, 'blocked')
    assert.equal(record.followUps.length, 1)

    const legacyDetails = JSON.parse(specDetails())
    delete legacyDetails.contractVersion
    delete legacyDetails.verification
    const legacy = auditTask(JSON.stringify(legacyDetails))
    await worker.releaseBatch([legacy])
    assert.equal(legacy.agentRun.releaseStatus, 'released')
    assert.equal(legacy.agentRun.releaseEvidence.liveVerification.skipped, true)
    assert.match(record.comments.at(-1), /legacy/)
  }, { verificationRunner: async () => assert.fail('без spec runner не викликається') })
})

test('втрачений повторний запуск після live-перевірки відновлюється на наступному тіку', async () => {
  await withWorker(async ({ worker, record }) => {
    await worker.recoverVerificationFollowUps([
      { id: 'A', status: 'in_progress', agentRun: { releaseStatus: 'blocked', releaseEvidence: { liveVerification: { followUp: 'requested', followUpComment: 'FAIL: 0/1' } } } },
      { id: 'B', status: 'blocked', agentRun: { releaseStatus: 'blocked', releaseEvidence: { liveVerification: { followUp: 'requested' } } } },
      { id: 'C', status: 'in_progress', agentRun: { releaseStatus: 'blocked', releaseEvidence: { liveVerification: { followUp: 'exhausted' } } } },
    ])
    assert.deepEqual(record.followUps.map((item) => [item.taskId, item.comment]), [['A', 'FAIL: 0/1']])
  })
})

test('з виводу гейтів дістаються саме тести й помилки компіляції, що падають', () => {
  const output = [
    ' FAIL  src/sales/Wizard.test.tsx > Wizard > keeps storage hidden on step 3',
    ' ✓ src/ok.test.ts (3 tests)',
    '  Failed Global.Business.Assistant.Tests.SalesTests.Recalculate [12 ms]',
    'src/x/File.cs(10,5): error CS1002: ; expected [/src/x/X.csproj]',
    "src/app.ts(3,1): error TS2322: Type 'string' is not assignable",
    ' FAIL  src/sales/Wizard.test.tsx > Wizard > keeps storage hidden on step 3',
  ].join('\n')
  assert.deepEqual(extractFailingTests(output), [
    'src/sales/Wizard.test.tsx > Wizard > keeps storage hidden on step 3',
    'Global.Business.Assistant.Tests.SalesTests.Recalculate',
    'x/File.cs: CS1002 ; expected',
    "src/app.ts: TS2322 Type 'string' is not assignable",
  ])
})

test('швидкий прогін пов’язаних тестів будується лише для змінених JS/TS файлів', () => {
  const plan = { checks: [['npx', 'vitest', 'run', '--silent', '--maxWorkers=8'], ['npm', 'run', 'build']] }
  assert.deepEqual(
    relatedTestCheck(plan, ['src/a.tsx', 'README.md', 'src/b.test.ts', 'src/a.tsx']),
    ['npx', 'vitest', 'related', '--run', '--silent', '--maxWorkers=8', 'src/a.tsx', 'src/b.test.ts'],
  )
  assert.equal(relatedTestCheck(plan, ['README.md']), null)
  assert.equal(relatedTestCheck({ checks: [['dotnet', 'test']] }, ['src/a.ts']), null)
})

test('guardian відкриває MAIN RED лише коли те саме падіння повторилось на двох SHA, далі оновлює одну задачу', async () => {
  const originalFetch = global.fetch
  const deskTasks = []
  const posts = []
  const patches = []
  let current = shaA
  global.fetch = async (url, init = {}) => {
    if (init.method === 'POST' && String(url).endsWith('/api/tasks')) {
      const task = { id: `BUG-MR-${deskTasks.length + 1}`, status: 'new', notes: init.body.get('notes'), title: init.body.get('title') }
      posts.push(Object.fromEntries(init.body.entries()))
      deskTasks.push(task)
      return { ok: true, json: async () => task }
    }
    if (init.method === 'PATCH') {
      const payload = JSON.parse(init.body)
      patches.push(payload)
      Object.assign(deskTasks[0], payload)
      return { ok: true, json: async () => deskTasks[0] }
    }
    return { ok: true, json: async () => deskTasks }
  }
  try {
    await withWorker(async ({ worker, record }) => {
      await worker.guardMainlines()
      await worker.guardMainlines()
      assert.equal(posts.length, 0, 'одне падіння під час розбиття тестів ще не задача')

      current = shaB
      await worker.guardMainlines()
      assert.equal(posts.length, 1)
      assert.equal(posts[0].title, `MAIN RED repo@${shaB.slice(0, 12)}`)
      assert.equal(posts[0].priority, 'high')
      assert.equal(posts[0].aiMode, 'off')
      assert.match(posts[0].notes, /\[main-red:repo\]/)
      assert.match(posts[0].description, /src\/flaky\.test\.ts/)

      await worker.guardMainlines()
      assert.equal(posts.length, 1, 'той самий SHA не створює дубль')

      current = 'c'.repeat(40)
      await worker.guardMainlines()
      assert.equal(posts.length, 1)
      assert.equal(patches[0].title, `MAIN RED repo@${'c'.repeat(12)}`)
      assert.match(record.comments.at(-1), /^\[конвеєр:main-red\]/)
    }, { guardianEnabled: true, mainline: () => current })
  } finally {
    global.fetch = originalFetch
  }
})

test('guardian відкриває MAIN RED і без нового SHA, якщо червоний main тримається довше за поріг', async () => {
  const originalFetch = global.fetch
  const posts = []
  global.fetch = async (url, init = {}) => {
    if (init.method === 'POST' && String(url).endsWith('/api/tasks')) {
      posts.push(Object.fromEntries(init.body.entries()))
      return { ok: true, json: async () => ({ id: 'BUG-MR-1' }) }
    }
    return { ok: true, json: async () => [] }
  }
  try {
    await withWorker(async ({ worker }) => {
      await worker.guardMainlines()
      assert.equal(posts.length, 0)
      worker.guardianState.get('repo').firstRedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString()
      await worker.guardMainlines()
      assert.equal(posts.length, 1)
      await worker.guardMainlines()
      assert.equal(posts.length, 1)
    }, { guardianEnabled: true })
  } finally {
    global.fetch = originalFetch
  }
})

test('guardian закриває MAIN RED, коли всі гейти на новому SHA зелені', async () => {
  const originalFetch = global.fetch
  const open = { id: 'BUG-MR-1', status: 'new', notes: '[main-red:repo] [main-red-sha:' + shaA + ']', title: 'MAIN RED repo@aaaa' }
  const patches = []
  global.fetch = async (_url, init = {}) => {
    if (init.method === 'PATCH') {
      patches.push(JSON.parse(init.body))
      return { ok: true, json: async () => open }
    }
    return { ok: true, json: async () => [open] }
  }
  try {
    await withWorker(async ({ worker, record, calls }) => {
      await worker.guardMainlines()
      assert.deepEqual(patches, [{ status: 'done' }])
      assert.match(record.comments[0], /^\[конвеєр:main-green\]/)
      assert.deepEqual(calls.filter((call) => call.command === 'verify' || call.command === 'build').map((call) => call.command), ['verify', 'build'])
    }, { guardianEnabled: true, verifyCode: () => 0, mainline: () => shaB })
  } finally {
    global.fetch = originalFetch
  }
})

test('фонова перевірка guardian поступається релізу, що з’явився, і не кешує результат', async () => {
  const originalFetch = global.fetch
  global.fetch = async () => ({ ok: true, json: async () => [{ id: 'R', status: 'in_progress', notes: '', agentRun: { status: 'completed', releaseStatus: 'pending' } }] })
  try {
    await withWorker(async ({ worker }) => {
      worker.runProcess = async (command, _args, options = {}) => {
        if (command !== 'verify') return { code: 0, output: shaA }
        return new Promise((resolve) => {
          const fakeChild = { pid: 0, kill: () => resolve({ code: 1, output: 'killed' }) }
          options.onChild?.(fakeChild)
          setTimeout(() => resolve({ code: 1, output: 'late' }), 200)
        })
      }
      const probe = await worker.probeMainlineGate('repo', shaA, gate, { preemptible: true })
      assert.equal(probe.status, 'aborted')
      assert.equal(await worker.mainlineGateCache.get(mainlineGateKey('repo', shaA, gate)), null)
    }, { guardianPreemptPollMs: 10 })
  } finally {
    global.fetch = originalFetch
  }
})

test('реліз спершу ганяє пов’язані vitest-тести і при падінні не запускає повну батарею', async () => {
  const { mkdir: makeDirectory, writeFile: write } = await import('node:fs/promises')
  const root = await mkdtemp(path.join(tmpdir(), 'gba-release-related-'))
  const worktree = path.join(root, 'worktrees', 'bug-5001', 'web')
  await makeDirectory(path.join(worktree, 'src'), { recursive: true })
  await write(path.join(worktree, '.git'), 'gitdir fixture', 'utf8')
  await write(path.join(worktree, 'src', 'Wizard.tsx'), 'export {}\n', 'utf8')
  const commands = []
  const fullVitest = ['npx', 'vitest', 'run', '--silent', '--maxWorkers=8']
  const worker = new ReleaseWorker({
    worktreesDirectory: path.join(root, 'worktrees'),
    deskBaseUrl: 'http://127.0.0.1:9',
    repoPlan: { web: { branch: 'main', root: path.join(root, 'main'), services: [], checks: [fullVitest, ['npm', 'run', 'build']] } },
    processRunner: async (command, args) => {
      commands.push([command, ...args].join(' '))
      if (command === 'npx' && args[1] === 'related') return { code: 1, output: ' FAIL  src/Wizard.test.tsx > hides storage' }
      if (args.includes('symbolic-ref')) return { code: 0, output: 'main' }
      if (args.includes('log')) return { code: 0, output: 'c'.repeat(40) }
      if (args.includes('rev-parse')) return { code: 0, output: shaA }
      if (args.includes('merge-base') && args.includes('--is-ancestor')) return { code: 1, output: '' }
      if (args.includes('merge-base')) return { code: 0, output: shaB }
      if (args.includes('diff') && args.includes('--name-only')) return { code: 0, output: 'src/Wizard.tsx\nsrc/removed.ts\n' }
      return { code: 0, output: '' }
    },
  })
  worker.updateRelease = async () => {}
  try {
    const outcome = await worker.releaseTask({
      id: 'BUG-5001',
      title: 'Related gate',
      agentRun: { id: 'RUN-5001', releaseRepositories: [], details: JSON.stringify({ releasePlan: { repositories: ['web'], services: [], migrationFiles: [], postDeployChecks: [{ label: 'x', url: 'http://127.0.0.1/health', expectedStatus: 200, contains: '' }] } }) },
    })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.kind, 'validation')
    assert.deepEqual(outcome.failedGate.check, fullVitest)
    assert.match(outcome.reason, /^web: перевірка «npx vitest run --silent --maxWorkers=8» впала на швидкому прогоні/)
    assert.match(outcome.reason, /hides storage/)
    assert.equal(commands.some((command) => command === 'npx vitest related --run --silent --maxWorkers=8 src/Wizard.tsx'), true)
    assert.equal(commands.some((command) => command === fullVitest.join(' ')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('відновлення розпізнає і динамічно відкритий dotnet-тестовий проєкт', () => {
  const plan = { 'gba-server': { branch: 'main', root: '/x', services: [], checks: [['dotnet', 'build', 'src/A.csproj'], { discover: 'dotnet-tests' }] } }
  const task = {
    status: 'blocked',
    agentRun: {
      status: 'completed',
      releaseStatus: 'blocked',
      releaseError: 'gba-server: перевірка «dotnet test tests/App.Actors.Sales.Tests/App.Actors.Sales.Tests.csproj -v q --nologo» впала; mainline не змінено',
      releaseEvidence: {},
    },
  }
  assert.deepEqual(mainlineRecoveryCandidate(task, plan)?.check, ['dotnet', 'test', 'tests/App.Actors.Sales.Tests/App.Actors.Sales.Tests.csproj', '-v', 'q', '--nologo'])
  const injected = { ...task, agentRun: { ...task.agentRun, releaseError: 'gba-server: перевірка «dotnet test tests/x.csproj; rm -rf /» впала' } }
  assert.equal(mainlineRecoveryCandidate(injected, plan), null)
})

test('UI-перевірка запускається на хості через ui-verify і класифікує pass/403/fail/env', async () => {
  const { mkdir: makeDirectory, writeFile: write } = await import('node:fs/promises')
  const uiSpec = {
    name: 'bug-6001-ui',
    url: '/products?netId=47b16aa5-fc36-4b56-ae75-17b607f4afcf',
    steps: [{ click: { role: 'button', name: 'Прихід' } }],
    checks: [{ type: 'rowCount', rowMatches: '2018', min: 1 }],
  }
  const task = {
    id: 'BUG-6001',
    status: 'in_progress',
    notes: '',
    agentRun: { id: 'RUN-6001', details: JSON.stringify({ contractVersion: 2, verification: { uiSpec } }) },
  }
  let mode = 'pass'
  const calls = []
  await withWorker(async ({ worker, root }) => {
    const runner = path.join(root, 'ui-verify', 'ui-verify.mjs')
    await makeDirectory(path.dirname(runner), { recursive: true })
    await write(runner, '', 'utf8')
    const resultFile = path.join(root, 'result.json')
    const screenshot = path.join(root, 'shot.png')
    await write(screenshot, 'png', 'utf8')
    worker.uiVerifyRunner = runner
    worker.uiVerifyDirectory = path.join(root, 'ui-out')
    const attachments = []
    worker.attachEvidence = async (_task, file, name) => attachments.push({ file, name }) > 0
    worker.runProcess = async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd })
      const exitCode = { pass: 0, forbidden: 1, fail: 1, spec: 2, env: 3 }[mode]
      await write(resultFile, JSON.stringify({ responses: mode === 'forbidden' ? [{ method: 'GET', path: '/api/v1/uk/storages/get/all', status: 403 }] : [], blockedRequests: [] }), 'utf8')
      const payload = { status: exitCode === 0 ? 'pass' : exitCode === 1 ? 'fail' : 'error', exitCode, results: [{ spec: 'bug-6001-ui', status: 'x', exitCode, resultFile, screenshot, failedChecks: exitCode === 1 ? [{ description: 'a 2018 receipt row' }] : [], error: exitCode >= 2 ? 'login 502' : null }] }
      return { code: exitCode, output: `human block\nUI_VERIFY_RESULT ${JSON.stringify(payload)}` }
    }

    const passed = await worker.runUiVerification(task)
    assert.equal(passed.ok, true)
    assert.equal(passed.evidence.status, 'pass')
    assert.equal(calls[0].command, 'node')
    assert.deepEqual(calls[0].args.slice(0, 1), [runner])
    assert.equal(calls[0].args.includes('--env'), true)
    assert.equal(calls[0].cwd, path.dirname(runner))
    assert.equal(attachments[0].name, 'ui-verify-bug-6001-pass.png')

    mode = 'forbidden'
    const forbidden = await worker.runUiVerification(task)
    assert.equal(forbidden.ok, true)
    assert.equal(forbidden.evidence.status, 'unverifiable')
    assert.match(forbidden.report, /403/)

    mode = 'fail'
    const failed = await worker.runUiVerification(task)
    assert.equal(failed.ok, false)
    assert.equal(failed.kind, 'scenario')
    assert.match(failed.reason, /a 2018 receipt row/)

    mode = 'spec'
    assert.equal((await worker.runUiVerification(task)).kind, 'scenario')
    mode = 'env'
    assert.equal((await worker.runUiVerification(task)).kind, 'transient')

    worker.uiVerifyRunner = path.join(root, 'missing.mjs')
    const skipped = await worker.runUiVerification(task)
    assert.equal(skipped.ok, true)
    assert.equal(skipped.evidence.status, 'skipped')
    assert.equal(await worker.runUiVerification({ ...task, agentRun: { details: '{}' } }), null)
  })
})

test('UI spec від Codex не може дозволяти запис, ходити поза консоль чи містити credentials', async () => {
  const { validateUiSpec } = await import('../server/verification-spec.js')
  const base = { name: 'bug-ui', url: '/clients', checks: [{ type: 'text', text: 'KD02801' }] }
  assert.equal(validateUiSpec(base).ok, true)
  assert.match(validateUiSpec({ ...base, allowNonGet: ['/x$'] }).errors.join(' '), /allowNonGet/)
  assert.match(validateUiSpec({ ...base, url: 'https://evil.example/' }).errors.join(' '), /шляхом консолі/)
  assert.match(validateUiSpec({ ...base, steps: [{ goto: 'https://gba-console.85.17.167.167.nip.io/' }] }).errors.join(' '), /goto/)
  assert.match(validateUiSpec({ ...base, steps: [{ fill: { locator: { label: 'Password' }, value: 'x' } }] }).errors.join(' '), /credentials/)
  assert.match(validateUiSpec({ ...base, env: 'qa' }).errors.join(' '), /env=dev/)
  assert.match(validateUiSpec({ ...base, checks: [{ type: 'magic' }] }).errors.join(' '), /type/)
})

const starvedOutput = [
  ...Array.from({ length: 8 }, (_, index) => ` FAIL  src/f${index}.test.tsx > s\nError: Hook timed out in 30000ms.`),
  ' Test Files  462 failed | 623 passed (1085)',
].join('\n')

test('падіння гейта через голодування хоста не зараховує спробу і не ставить hold', async () => {
  let calls = 0
  await withWorker(async ({ worker, record }) => {
    worker.runProcess = async (command) => {
      if (command !== 'verify') return { code: 0, output: shaA }
      calls += 1
      return { code: 1, output: starvedOutput }
    }
    const result = await worker.runReleaseCheck('repo', ['verify', '--maxWorkers=8'], '/tmp')
    assert.equal(result.environment, true)
    assert.equal(calls, 2, 'один повтор зі зменшеними воркерами')

    const task = humanTask()
    await worker.handleReleaseFailure(task, { ok: false, kind: 'environment', phase: 'validating', reason: 'repo: «verify» впав через середовище' })
    assert.equal(task.agentRun.releaseStatus, 'retrying')
    assert.equal(task.agentRun.releaseAttempts, 1)
    assert.match(record.annotations.at(-1), /середовище, спробу не зараховано/)

    const probe = await worker.probeMainlineGate('repo', shaA, gate)
    assert.equal(probe.status, 'environment')
    assert.equal(await worker.mainlineGateCache.get(mainlineGateKey('repo', shaA, gate)), null)
    const held = humanTask()
    await worker.handleReleaseFailure(held, gateFailure())
    assert.equal(held.agentRun.releaseStatus, 'retrying')
    assert.equal(held.agentRun.releaseAttempts, 1)
  })
})

test('повторний прогін зі зменшеними воркерами рятує гейт від голодування', async () => {
  const seen = []
  await withWorker(async ({ worker }) => {
    worker.runProcess = async (command, args) => {
      seen.push(args.join(' '))
      return seen.length === 1 ? { code: 1, output: starvedOutput } : { code: 0, output: 'ok' }
    }
    const result = await worker.runReleaseCheck('repo', ['npx', 'vitest', 'run', '--maxWorkers=8'], '/tmp')
    assert.equal(result.code, 0)
    assert.equal(result.environmentRetry, true)
    assert.deepEqual(seen, ['vitest run --maxWorkers=8', 'vitest run --maxWorkers=4'])
  })
})

test('guardian не відкриває MAIN RED на голодуванні хоста та без підтвердного прогону', async () => {
  const originalFetch = global.fetch
  const posts = []
  global.fetch = async (url, init = {}) => {
    if (init.method === 'POST' && String(url).endsWith('/api/tasks')) {
      posts.push(Object.fromEntries(init.body.entries()))
      return { ok: true, json: async () => ({ id: 'BUG-MR' }) }
    }
    return { ok: true, json: async () => [] }
  }
  let mode = 'starved'
  let current = shaA
  try {
    await withWorker(async ({ worker }) => {
      worker.runProcess = async (command) => {
        if (command === 'git') return { code: 0, output: current }
        if (command !== 'verify') return { code: 0, output: '' }
        if (mode === 'starved') return { code: 1, output: starvedOutput }
        if (mode === 'flaky-red') {
          mode = 'green'
          return { code: 1, output: ' FAIL  src/a.test.ts > breaks' }
        }
        return { code: 0, output: '' }
      }
      await worker.guardMainlines()
      assert.equal(worker.guardianState.get('repo').status, 'environment')
      current = shaB
      await worker.guardMainlines()
      assert.equal(posts.length, 0, 'масові таймаути — не MAIN RED')

      mode = 'flaky-red'
      current = 'c'.repeat(40)
      worker.guardianState.set('repo', { sha: shaB, status: 'red', failedCheck: gate.join(' '), firstRedAt: new Date().toISOString(), consecutive: 1, at: new Date().toISOString() })
      await worker.guardMainlines()
      assert.equal(posts.length, 0, 'підтвердний прогін зелений — задачі немає')
      assert.equal(worker.guardianState.get('repo').status, 'green')
    }, { guardianEnabled: true, guardianEnvironmentRetryMs: 0 })
  } finally {
    global.fetch = originalFetch
  }
})

test('закешований «червоний» результат голодування не тримає релізи', async () => {
  await withWorker(async ({ worker, calls }) => {
    await worker.mainlineGateCache.set(mainlineGateKey('repo', shaA, gate), { status: 'red', at: new Date().toISOString(), output: starvedOutput })
    const probe = await worker.probeMainlineGate('repo', shaA, gate)
    assert.equal(probe.status, 'green')
    assert.equal(calls.filter((call) => call.command === 'verify').length, 1)
  }, { verifyCode: () => 0 })
})

test('UI spec для екрана, закритого для QA Verifier, не валить реліз, а позначається як неперевірний', async () => {
  const { validateUiSpec } = await import('../server/verification-spec.js')
  const wizard = { name: 'bug-1391-ui', url: '/sales/ukraine/all', steps: [{ click: { role: 'button', name: 'Новий продаж' } }], checks: [{ type: 'text', text: 'KD02801' }] }
  const gated = validateUiSpec(wizard)
  assert.equal(gated.ok, false)
  assert.equal(gated.unverifiable, true)
  assert.match(gated.errors[0], /Новий продаж/)
  const badShape = validateUiSpec({ name: 'x', url: '/clients', steps: [{ fill: { placeholder: 'Пошук', value: 'KD02801' } }], checks: [{ type: 'text', text: 'KD02801' }] })
  assert.match(badShape.errors.join(' '), /fill має формат \{"locator"/)
  assert.equal(validateUiSpec({ name: 'x', url: '/clients', steps: [{ fill: { locator: { placeholder: 'Пошук' }, value: 'KD02801' } }, { press: { locator: { placeholder: 'Пошук' }, key: 'Enter' } }, { wait: 500 }], checks: [{ type: 'text', text: 'KD02801' }] }).ok, true)

  await withWorker(async ({ worker }) => {
    worker.runProcess = async () => assert.fail('runner не запускається для закритого екрана')
    const result = await worker.runUiVerification({ id: 'BUG-1391', agentRun: { details: JSON.stringify({ verification: { uiSpec: wizard } }) } })
    assert.equal(result.ok, true)
    assert.equal(result.evidence.status, 'unverifiable')
  })
})
