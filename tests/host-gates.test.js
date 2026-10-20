import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  HostGateLimiter,
  acquireLockFile,
  classifyGateOutput,
  gateKind,
  reducedWorkersCommand,
  scanHeavyProcesses,
} from '../server/host-gates.js'

test('масові таймаути vitest і падіння воркерів класифікуються як середовище, а справжня регресія — ні', () => {
  const starved = [
    ...Array.from({ length: 12 }, (_, index) => ` FAIL  src/feature-${index}.test.tsx > suite\nError: Hook timed out in 30000ms.`),
    ' Test Files  462 failed | 623 passed (1085)',
    '      Tests  1210 failed | 5012 passed (6222)',
  ].join('\n')
  const starvedResult = classifyGateOutput(starved)
  assert.equal(starvedResult.environment, true)
  assert.equal(starvedResult.failedFiles, 462)
  assert.equal(starvedResult.totalFiles, 1085)
  assert.match(starvedResult.reasons.join(' '), /масові таймаути/)

  const regression = [
    ' FAIL  src/sales/Wizard.test.tsx > hides storage on step 3',
    'AssertionError: expected "Склад" not to be visible',
    ' Test Files  1 failed | 1084 passed (1085)',
    '      Tests  1 failed | 6221 passed (6222)',
  ].join('\n')
  assert.equal(classifyGateOutput(regression).environment, false)

  const singleTimeout = [
    ' FAIL  src/slow.test.tsx > loads',
    'Error: Test timed out in 5000ms.',
    ' Test Files  1 failed | 1084 passed (1085)',
  ].join('\n')
  assert.equal(classifyGateOutput(singleTimeout).environment, false)

  assert.equal(classifyGateOutput('Error: Worker exited unexpectedly\n Test Files  3 failed | 1082 passed (1085)').environment, true)
  assert.equal(classifyGateOutput('The active test run was aborted. Reason: Test host process crashed').environment, true)
  assert.equal(classifyGateOutput('Failed!  - Failed:     1, Passed:  2883, Skipped: 0').environment, false)
})

test('вид гейта й зменшення воркерів для повторного прогону', () => {
  assert.equal(gateKind(['dotnet', 'test', 'tests/A.Tests/A.Tests.csproj']), 'dotnet-test')
  assert.equal(gateKind(['dotnet', 'build', 'src/A/A.csproj']), 'dotnet-build')
  assert.equal(gateKind(['npx', 'vitest', 'run', '--silent']), 'vitest')
  assert.equal(gateKind(['npx', 'vitest', 'related', '--run', 'src/a.ts']), 'vitest-related')
  assert.equal(gateKind(['npm', 'run', 'build']), 'js-build')
  assert.equal(gateKind(['verify']), 'other')
  assert.deepEqual(reducedWorkersCommand(['npx', 'vitest', 'run', '--maxWorkers=8']), ['npx', 'vitest', 'run', '--maxWorkers=4'])
  assert.deepEqual(reducedWorkersCommand(['npx', 'vitest', 'run', '--maxWorkers=2']), ['npx', 'vitest', 'run', '--maxWorkers=2'])
})

test('скан /proc рахує лише верхньорівневі dotnet test/build і головні процеси vitest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-proc-'))
  const processEntry = async (pid, args) => {
    await mkdir(path.join(root, String(pid)), { recursive: true })
    await writeFile(path.join(root, String(pid), 'cmdline'), `${args.join('\0')}\0`, 'utf8')
  }
  try {
    await processEntry(10, ['/usr/share/dotnet/dotnet', 'test', 'tests/A.csproj'])
    await processEntry(11, ['/usr/share/dotnet/dotnet', '/usr/share/dotnet/sdk/10/MSBuild.dll', '-nodeReuse'])
    await processEntry(12, ['dotnet', 'build', 'src/A.csproj'])
    await processEntry(13, ['node', '/repo/node_modules/.bin/vitest', 'run', '--silent'])
    await processEntry(14, ['node', '--experimental-import-meta-resolve', '/repo/node_modules/tinypool/dist/process.js'])
    await processEntry(15, ['/usr/share/dotnet/dotnet', 'exec', '/x/testhost.dll'])
    await mkdir(path.join(root, 'self'), { recursive: true })
    assert.deepEqual(await scanHeavyProcesses(root), { dotnetTest: 1, dotnetBuild: 1, vitest: 1 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('лімітер не пускає повний vitest при двох dotnet test і четвертий dotnet понад ліміт', async () => {
  let counts = { dotnetTest: 2, dotnetBuild: 0, vitest: 0 }
  let load = 4
  const root = await mkdtemp(path.join(tmpdir(), 'gba-gate-locks-'))
  const limiter = new HostGateLimiter({ lockDirectory: root, maxDotnet: 3, maxLoad: 20, pollMs: 1, scan: async () => counts, load: () => load, sleep: async () => {} })
  try {
    assert.equal((await limiter.admissible('vitest')).ok, false)
    assert.equal((await limiter.admissible('dotnet-test')).ok, true)
    counts = { dotnetTest: 2, dotnetBuild: 1, vitest: 0 }
    assert.equal((await limiter.admissible('dotnet-build')).ok, false)
    counts = { dotnetTest: 1, dotnetBuild: 0, vitest: 0 }
    assert.equal((await limiter.admissible('vitest')).ok, true)
    load = 30
    assert.match((await limiter.admissible('vitest')).reason, /load average/)
    assert.equal((await limiter.admissible('other')).ok, true)

    let clock = 0
    const busy = await limiter.acquire('vitest', { maxWaitMs: 10, now: () => (clock += 5) })
    assert.equal(busy.release, null)
    assert.equal(busy.busy, true)

    load = 1
    const first = await limiter.acquire('vitest')
    const second = await limiter.acquire('vitest', { maxWaitMs: 0 })
    assert.equal(typeof first.release, 'function')
    assert.equal(second.release, null, 'один js-слот на хост')
    await first.release()
    const third = await limiter.acquire('vitest', { maxWaitMs: 0 })
    assert.equal(typeof third.release, 'function')
    await third.release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('lock-файл мертвого процесу підхоплюється, живого — ні', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-gate-lock-'))
  try {
    const file = path.join(root, 'dotnet-1.lock')
    await writeFile(file, '999999999\n2026-10-20\n', 'utf8')
    const release = await acquireLockFile(file)
    assert.equal(typeof release, 'function')
    assert.equal(await acquireLockFile(file), null)
    await release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('точний хвіст BUG-1393 (ANSI-кольори, лічильник [36/2518], без підсумку) — це середовище', async () => {
  const { readFile } = await import('node:fs/promises')
  const { extractFailingTests } = await import('../server/release-worker.js')
  const { gateSummaryLines, stripAnsi } = await import('../server/host-gates.js')
  const tail = await readFile(new URL('./fixtures/bug-1393-vitest-tail.txt', import.meta.url), 'utf8')
  assert.match(tail, /\u001b\[41m\u001b\[1m FAIL/)
  const result = classifyGateOutput(tail)
  assert.equal(result.environment, true)
  assert.equal(result.failedTests, 2518)
  assert.match(result.reasons.join(' '), /масові таймаути: 2518/)
  assert.deepEqual(extractFailingTests(tail), [
    'src/features/reports/pages/SupplierDebtReportPanel.test.tsx > aborts deferred old caller output without clearing a newer loading state or leaking old links',
  ])
  assert.doesNotMatch(stripAnsi(tail), /\u001b/)
  const colouredSummary = '\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m412 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m673 passed\u001b[39m\u001b[22m\u001b[90m (1085)\u001b[39m\nError: Hook timed out in 30000ms.'
  assert.equal(classifyGateOutput(colouredSummary).environment, true)
  assert.deepEqual(gateSummaryLines(colouredSummary), ['Test Files  412 failed | 673 passed (1085)'])
  const realRegression = '\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m src/a.test.ts > breaks\nAssertionError: expected 1 to be 2\n\u001b[31m⎯⎯⎯[1/1]⎯\u001b[39m'
  assert.equal(classifyGateOutput(realRegression).environment, false)
})

test('повний vitest бере хост ексклюзивно: js-1 і всі dotnet-слоти, а js-pending зупиняє нових dotnet-учасників', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const root = await mkdtemp(path.join(tmpdir(), 'gba-gate-exclusive-'))
  const quiet = { dotnetTest: 0, dotnetBuild: 0, vitest: 0 }
  const make = () => new HostGateLimiter({
    lockDirectory: root,
    maxDotnet: 3,
    maxLoad: 50,
    pollMs: 5,
    scan: async () => quiet,
    load: () => 1,
  })
  const limiter = make()
  const other = make()
  try {
    const vitest = await limiter.acquire('vitest', { maxWaitMs: 0 })
    assert.equal(vitest.exclusive, true)
    assert.deepEqual((await readdir(root)).sort(), ['dotnet-1.lock', 'dotnet-2.lock', 'dotnet-3.lock', 'js-1.lock'])
    assert.equal((await other.acquire('dotnet-test', { maxWaitMs: 0 })).release, null)
    assert.equal((await other.acquire('vitest-related', { maxWaitMs: 0 })).release, null)
    await vitest.release()
    assert.deepEqual(await readdir(root), [])

    const related = await limiter.acquire('vitest-related', { maxWaitMs: 0 })
    const dotnetBeside = await other.acquire('dotnet-test', { maxWaitMs: 0 })
    assert.equal(typeof dotnetBeside.release, 'function', 'короткий vitest related лишається на легкому правилі')
    await related.release()
    await dotnetBeside.release()

    await writeFile(path.join(root, 'dotnet-2.lock'), `${process.ppid}\n2026-10-20T16:00:00Z\n`, 'utf8')
    const waiting = limiter.acquire('vitest', { maxWaitMs: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal((await readFile(path.join(root, 'js-pending'), 'utf8')).split('\n')[0], String(process.pid))
    await writeFile(path.join(root, 'js-pending'), `${process.ppid}\n2026-10-20T16:00:00Z\n`, 'utf8')
    assert.equal(await other.foreignExclusivePending(), true)
    assert.equal((await other.acquire('dotnet-test', { maxWaitMs: 0 })).release, null, 'живий js-pending тримає нових dotnet-учасників')
    await rm(path.join(root, 'dotnet-2.lock'), { force: true })
    const granted = await waiting
    assert.equal(granted.exclusive, true)
    assert.equal((await readdir(root)).includes('js-pending'), false)
    await granted.release()
    assert.deepEqual(await readdir(root), [])

    await writeFile(path.join(root, 'js-pending'), '999999999\n2026-10-20T16:00:00Z\n', 'utf8')
    assert.equal(await other.foreignExclusivePending(), false, 'маркер мертвого процесу прибирається')
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
