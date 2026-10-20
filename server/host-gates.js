import { mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { availableParallelism, loadavg } from 'node:os'
import path from 'node:path'

export const DEFAULT_GATE_LOCK_DIRECTORY = '/run/lock/gba-gates'
const TIMEOUT_PATTERN = /(?:Hook|Test) timed out in \d+\s*ms|timed out after \d+\s*ms|\bTimeoutError\b|Timed out waiting/gi
const CRASH_PATTERN = /Worker exited unexpectedly|Tinypool|ERR_IPC_CHANNEL_CLOSED|Test host process crashed|The active test run was aborted|Reason: Test host process|JavaScript heap out of memory|\bENOMEM\b|Cannot allocate memory|Killed\s*$/im

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

export function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_PATTERN, '')
}

export function gateSummaryLines(output) {
  return stripAnsi(output)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(?:Test Files|Tests|Errors?|Duration)\s/.test(line) || /^(?:Failed|Passed)!\s*-/.test(line))
    .slice(-6)
}

export function gateKind(command = []) {
  const joined = command.join(' ')
  if (command[0] === 'dotnet' && command[1] === 'test') return 'dotnet-test'
  if (command[0] === 'dotnet') return 'dotnet-build'
  if (/\bvitest\b/.test(joined) && /\brelated\b/.test(joined)) return 'vitest-related'
  if (/\bvitest\b/.test(joined)) return 'vitest'
  if (/\bnext\s+build\b|\bnpm run build\b|\bvite build\b/.test(joined)) return 'js-build'
  return 'other'
}

export function classifyGateOutput(output, { failureRatio = 0.05, massFailures = 100 } = {}) {
  const text = stripAnsi(output)
  const files = /Test Files\s+(\d+)\s+failed(?:\s*\|\s*(\d+)\s+passed)?[^(\n]*\((\d+)\)/.exec(text)
  const tests = /\bTests\s+(\d+)\s+failed/.exec(text)
  const dotnet = /Failed!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+)/.exec(text)
  const counters = [...text.matchAll(/\[(\d+)\/(\d+)\]/g)].map((match) => Number(match[2]))
  const reportedFailures = counters.length > 0 ? Math.max(...counters) : 0
  const failedFiles = files ? Number(files[1]) : 0
  const totalFiles = files ? Number(files[3]) : 0
  const failedTests = tests ? Number(tests[1]) : dotnet ? Number(dotnet[1]) : reportedFailures
  const totalTests = dotnet ? Number(dotnet[1]) + Number(dotnet[2]) : 0
  const timeouts = (text.match(TIMEOUT_PATTERN) ?? []).length
  const failureLines = (text.match(/^\s*(?:FAIL|×|✗)\s+\S/gm) ?? []).length + (text.match(/^\s*Failed\s+\S/gm) ?? []).length
  const crashed = CRASH_PATTERN.test(text)
  const massFiles = totalFiles > 0 && failedFiles / totalFiles > failureRatio
  const massTests = (totalTests > 0 && failedTests / totalTests > failureRatio) || failedTests >= massFailures
  const timeoutDominated = timeouts > 0 && timeouts >= Math.max(1, failureLines) * 0.5
  const environment = crashed || (timeouts > 0 && (massFiles || massTests)) || (timeoutDominated && (failedFiles >= 3 || failedTests >= 5 || failureLines >= 5))
  const reasons = []
  if (crashed) reasons.push('падіння воркерів/testhost або нестача пам’яті')
  if (timeouts > 0 && (massFiles || massTests)) reasons.push(`масові таймаути: ${failedFiles || failedTests} з ${totalFiles || totalTests || '?'}`)
  else if (timeoutDominated) reasons.push(`більшість падінь — таймаути (${timeouts})`)
  return { environment, reasons, failedFiles, totalFiles, failedTests, timeouts, crashed }
}

export function reducedWorkersCommand(command, divisor = 2, minimum = 2) {
  return command.map((argument) => {
    const match = /^--maxWorkers=(\d+)$/.exec(argument)
    if (!match) return argument
    return `--maxWorkers=${Math.max(minimum, Math.floor(Number(match[1]) / divisor))}`
  })
}

export async function scanHeavyProcesses(procRoot = '/proc') {
  const counts = { dotnetTest: 0, dotnetBuild: 0, vitest: 0 }
  let entries = []
  try {
    entries = await readdir(procRoot)
  } catch {
    return counts
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let raw
    try {
      raw = await readFile(path.join(procRoot, entry, 'cmdline'), 'utf8')
    } catch {
      continue
    }
    const args = raw.split('\0').filter(Boolean)
    if (args.length === 0) continue
    const executable = path.basename(args[0])
    if (executable === 'dotnet' && args[1] && !args[1].endsWith('.dll')) {
      if (args[1] === 'test' || args[1] === 'vstest') counts.dotnetTest += 1
      else if (['build', 'msbuild', 'publish', 'run'].includes(args[1])) counts.dotnetBuild += 1
      continue
    }
    const script = args.slice(1).find((argument) => !argument.startsWith('-')) ?? ''
    if (/(?:^|\/)vitest(?:\.mjs)?$/.test(script) && args.some((argument) => argument === 'run' || argument === 'related')) counts.vitest += 1
  }
  return counts
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export async function acquireLockFile(file) {
  await mkdir(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx')
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`)
      await handle.close()
      return async () => {
        await rm(file, { force: true })
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const owner = Number.parseInt((await readFile(file, 'utf8').catch(() => '')).split('\n')[0], 10)
      if (Number.isInteger(owner) && owner > 0 && processAlive(owner)) return null
      await rm(file, { force: true })
    }
  }
  return null
}

export const EXCLUSIVE_PENDING_MARKER = 'js-pending'

async function readLockOwner(file) {
  const owner = Number.parseInt((await readFile(file, 'utf8').catch(() => '')).split('\n')[0], 10)
  return Number.isInteger(owner) && owner > 0 ? owner : null
}

export class HostGateLimiter {
  constructor({
    lockDirectory = process.env.RELEASE_GATE_LOCK_DIR ?? DEFAULT_GATE_LOCK_DIRECTORY,
    maxDotnet = Number.parseInt(process.env.RELEASE_GATE_MAX_DOTNET ?? '3', 10),
    maxDotnetTestsForVitest = Number.parseInt(process.env.RELEASE_GATE_MAX_DOTNET_FOR_VITEST ?? '1', 10),
    maxLoad = Number.parseFloat(process.env.RELEASE_GATE_MAX_LOAD ?? String(Math.max(8, availableParallelism() * 0.3))),
    pollMs = 15_000,
    scan = scanHeavyProcesses,
    load = () => loadavg()[0],
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    this.lockDirectory = lockDirectory
    this.maxDotnet = maxDotnet
    this.maxDotnetTestsForVitest = maxDotnetTestsForVitest
    this.maxLoad = maxLoad
    this.pollMs = pollMs
    this.scan = scan
    this.load = load
    this.sleep = sleep
  }

  async snapshot() {
    const counts = await this.scan()
    return { ...counts, load: this.load() }
  }

  async admissible(kind) {
    const state = await this.snapshot()
    const dotnet = state.dotnetTest + state.dotnetBuild
    if (kind === 'dotnet-test' || kind === 'dotnet-build') {
      if (dotnet >= this.maxDotnet) return { ok: false, state, reason: `уже працює ${dotnet} dotnet build/test (ліміт ${this.maxDotnet})` }
    }
    if (kind === 'vitest') {
      if (state.dotnetTest > this.maxDotnetTestsForVitest) return { ok: false, state, reason: `працює ${state.dotnetTest} dotnet test — повний vitest не стартує` }
      if (state.vitest > 0) return { ok: false, state, reason: 'уже працює інший vitest' }
    }
    if (kind !== 'other' && state.load > this.maxLoad) return { ok: false, state, reason: `load average ${state.load.toFixed(1)} > ${this.maxLoad}` }
    return { ok: true, state }
  }

  async foreignExclusivePending() {
    const file = path.join(this.lockDirectory, EXCLUSIVE_PENDING_MARKER)
    const owner = await readLockOwner(file)
    if (owner === null) return false
    if (owner === process.pid) return false
    if (processAlive(owner)) return true
    await rm(file, { force: true })
    return false
  }

  exclusiveLockFiles() {
    return [
      path.join(this.lockDirectory, 'js-1.lock'),
      ...Array.from({ length: Math.max(1, this.maxDotnet) }, (_, index) => path.join(this.lockDirectory, `dotnet-${index + 1}.lock`)),
    ]
  }

  async acquireExclusive({ maxWaitMs, now, onWait }) {
    const started = now()
    const held = new Map()
    let marker = null
    let last = null
    let announced = false
    const releaseHeld = async () => {
      for (const release of held.values()) await release()
      held.clear()
    }
    try {
      while (true) {
        if (!marker && maxWaitMs > 0) marker = await acquireLockFile(path.join(this.lockDirectory, EXCLUSIVE_PENDING_MARKER))
        if (!marker && await this.foreignExclusivePending()) {
          last = { ok: false, reason: 'інший повний vitest уже чекає на хост' }
        } else {
          for (const file of this.exclusiveLockFiles()) {
            if (held.has(file)) continue
            const release = await acquireLockFile(file)
            if (release) held.set(file, release)
          }
          if (held.size === this.exclusiveLockFiles().length) {
            last = await this.admissible('vitest')
            if (last.ok) {
              await marker?.()
              marker = null
              return { release: releaseHeld, waitedMs: now() - started, state: last.state, forced: false, exclusive: true }
            }
          } else {
            last = { ok: false, reason: 'повний vitest чекає, поки інші раннери звільнять слоти js-1 і dotnet-1..3' }
          }
        }
        if (now() - started >= maxWaitMs) {
          await releaseHeld()
          await marker?.()
          return { release: null, waitedMs: now() - started, state: last?.state ?? null, forced: false, busy: true, reason: last?.reason }
        }
        if (!announced) {
          announced = true
          onWait?.(last?.reason ?? 'хост зайнятий')
        }
        await this.sleep(this.pollMs)
      }
    } catch (error) {
      await releaseHeld()
      await marker?.()
      throw error
    }
  }

  async acquire(kind, { maxWaitMs = 30 * 60 * 1000, now = () => Date.now(), onWait } = {}) {
    if (kind === 'other') return { release: async () => {}, waitedMs: 0, state: null, forced: false }
    if (kind === 'vitest') return this.acquireExclusive({ maxWaitMs, now, onWait })
    const started = now()
    let last = null
    let announced = false
    while (true) {
      last = kind.startsWith('dotnet') && await this.foreignExclusivePending()
        ? { ok: false, state: null, reason: 'повний vitest чекає на хост (js-pending) — новий dotnet не стартує' }
        : await this.admissible(kind)
      if (last.ok) {
        const lock = await this.lockSlot(kind)
        if (lock) return { release: lock, waitedMs: now() - started, state: last.state, forced: false }
        last = { ...last, ok: false, reason: 'усі слоти гейтів зайняті іншими раннерами' }
      }
      if (now() - started >= maxWaitMs) {
        return { release: null, waitedMs: now() - started, state: last.state, forced: false, busy: true, reason: last.reason }
      }
      if (!announced) {
        announced = true
        onWait?.(last.reason)
      }
      await this.sleep(this.pollMs)
    }
  }

  async lockSlot(kind) {
    const slots = kind.startsWith('dotnet') ? Math.max(1, this.maxDotnet) : 1
    const family = kind.startsWith('dotnet') ? 'dotnet' : 'js'
    for (let slot = 1; slot <= slots; slot += 1) {
      const release = await acquireLockFile(path.join(this.lockDirectory, `${family}-${slot}.lock`))
      if (release) return release
    }
    return null
  }
}
