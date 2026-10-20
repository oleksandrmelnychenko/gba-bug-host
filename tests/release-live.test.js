import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MAX_VERIFICATION_ATTEMPTS,
  MainlineGateCache,
  ReleaseWorker,
  mainlineGateKey,
  mainlineRecoveryCandidate,
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
