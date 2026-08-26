import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { materializeInstalledDependencies } from './worktree-dependencies.js'

const RELEASE_MARKER = /\[released:([^\]]+)\]/g
const BLOCKED_MARKER = /\[release-blocked:([^\]]+)\]/g
const SENTINEL_MARKER = /\[sentinel:[0-9a-f]{12}\]/
const MAX_RELEASE_ATTEMPTS = 3
const DEFAULT_PROCESS_TIMEOUT_MS = 45 * 60 * 1000
const COMPOSE_ARGS = ['compose', '-p', 'gba-dev', '-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml', '--env-file', '.env.dev']
const REPOSITORY_SHA_ENV = {
  gba_console: 'GBA_CONSOLE_GIT_SHA',
  'gba-server': 'GBA_SERVER_GIT_SHA',
  gba_ecommerce: 'GBA_ECOMMERCE_GIT_SHA',
  'gba-ecommerce-api': 'GBA_ECOMMERCE_API_GIT_SHA',
}

export function classifyGitPushFailure(output) {
  return /(?:non-fast-forward|\[rejected\].*(?:fetch first|non-fast-forward)|tip of your current branch is behind)/is.test(output ?? '')
    ? 'repository'
    : 'transient'
}

export function classifyPostDeployCheckFailure({ code, status }) {
  return code !== 0 || !Number.isInteger(status) || status >= 500
    ? 'transient'
    : 'validation'
}

export const serviceProbes = {
  'gba-console': 'http://127.0.0.1:8083/build.json',
  'data-concord': 'http://127.0.0.1:35981/health',
  'data-analytics': 'http://127.0.0.1:35982/health',
  'gba-ecommerce': 'http://127.0.0.1:8081/',
  'gba-ecommerce-api': 'http://127.0.0.1:62506/health',
}

export const defaultRepoPlan = {
  gba_console: {
    branch: 'main',
    root: '/root/projects/gba_console',
    services: ['gba-console'],
    checks: [
      ['npx', 'vitest', 'run', '--silent', '--maxWorkers=8'],
      ['npm', 'run', 'build'],
    ],
  },
  'gba-server': {
    branch: 'development',
    root: '/root/projects/gba-server',
    services: ['data-concord', 'data-analytics'],
    checks: [
      ['dotnet', 'build', 'src/Global.Business.Assistant.Api/Global.Business.Assistant.Api.csproj', '-v', 'q', '--nologo'],
      {
        command: ['dotnet', 'test', 'tests/Global.Business.Assistant.Api.Tests/Global.Business.Assistant.Api.Tests.csproj', '-v', 'q', '--nologo'],
        paths: [
          'src/Global.Business.Assistant.Api/',
          'src/Global.Business.Assistant.WebApi/',
          'src/Global.Business.Assistant.Application/',
          'src/Global.Business.Assistant.Database/',
          'tests/Global.Business.Assistant.Api.Tests/',
        ],
      },
      {
        command: ['dotnet', 'test', 'tests/Global.Business.Assistant.Platform.Actors.Tests/Global.Business.Assistant.Platform.Actors.Tests.csproj', '-v', 'q', '--nologo'],
        paths: [
          '.Actors/',
          '.Persistence/',
          'src/Global.Business.Assistant.Database/',
          'src/Global.Business.Assistant.Domain/',
          'tests/Global.Business.Assistant.Platform.Actors.Tests/',
        ],
      },
      {
        command: ['dotnet', 'test', 'tests/Global.Business.Assistant.Domain.Tests/Global.Business.Assistant.Domain.Tests.csproj', '-v', 'q', '--nologo'],
        paths: [
          'src/Global.Business.Assistant.Domain/',
          'tests/Global.Business.Assistant.Domain.Tests/',
        ],
      },
    ],
    migration: {
      command: 'env',
      args: [
        'IMAGE=gba-db-migrator:dev',
        'PROJECT=Global.Business.Assistant.Database.Migrator',
        'ENV_FILE=/dev/null',
        'SECRETS_DIR=/root/projects/gba-infra/secrets/dev',
        'DOCKER_NETWORK=gba-dev_default',
        'DATABASE_MIGRATIONS_COMMAND_TIMEOUT_SECONDS=3600',
        './scripts/run-concord-migrations-docker.sh',
      ],
      timeoutMs: 90 * 60 * 1000,
    },
  },
  gba_ecommerce: {
    branch: 'development',
    root: '/root/projects/gba_ecommerce',
    services: ['gba-ecommerce'],
    checks: [
      ['npx', 'vitest', 'run', '--silent', '--maxWorkers=8'],
      ['npx', 'next', 'build'],
    ],
  },
  'gba-ecommerce-api': {
    branch: 'development',
    root: '/root/projects/gba-ecommerce-api',
    services: ['gba-ecommerce-api'],
    checks: [
      ['dotnet', 'build', 'src/GBA.Ecommerce/GBA.Ecommerce.csproj', '-v', 'q', '--nologo'],
      ['dotnet', 'test', 'tests/GBA.Ecommerce.Api.Tests/GBA.Ecommerce.Api.Tests.csproj', '-v', 'q', '--nologo'],
    ],
  },
}

export function taskSlug(taskId) {
  return taskId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')
}

export function branchName(taskId) {
  return `codex/qa-${taskSlug(taskId)}`
}

function latestMarkerAt(notes, marker) {
  let found = false
  let newest = null
  for (const match of (notes ?? '').matchAll(marker)) {
    found = true
    const raw = match[1].trim()
    const legacyMinute = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)
    // Старі мітки мали точність лише до хвилини. Для них межею є кінець
    // хвилини, інакше run із finishedAt=:30 помилково випускається вдруге.
    const parsedBase = legacyMinute
      ? Date.parse(`${raw.replace(' ', 'T')}:00Z`)
      : Date.parse(raw)
    const parsed = legacyMinute && !Number.isNaN(parsedBase) ? parsedBase + 59_999 : parsedBase
    if (!Number.isNaN(parsed) && (newest === null || parsed > newest)) newest = parsed
  }
  // Мітка без читабельного часу (старий або зіпсований формат) має лишатись
  // бар'єром назавжди — інакше одна крива нотатка відкриє задачу на перевипуск.
  if (found && newest === null) return Number.POSITIVE_INFINITY
  return newest
}

export function isReleased(task) {
  if (task.agentRun?.releaseStatus === 'released') return true
  return latestMarkerAt(task.notes, RELEASE_MARKER) !== null
}

/**
 * Коли конвеєр востаннє «закрив» задачу — випуском або через впертий провал.
 * Друга спроба Codex після релізу раніше лишалась у worktree назавжди: мітка
 * [released:...] назавжди виключала задачу з вибірки, хоч робота була нова.
 */
export function lastGateAt(task) {
  const released = latestMarkerAt(task.notes, RELEASE_MARKER)
  const blocked = latestMarkerAt(task.notes, BLOCKED_MARKER)
  if (released === null) return blocked
  if (blocked === null) return released
  return Math.max(released, blocked)
}

export function hasWorkNewerThanGate(task) {
  const gate = lastGateAt(task)
  if (gate === null) return true
  const finishedAt = Date.parse(task.agentRun?.finishedAt ?? task.agentRun?.updatedAt ?? '')
  return !Number.isNaN(finishedAt) && finishedAt > gate
}

const SANDBOX_LIMIT_PATTERNS = [
  /пісочниц/i,
  /\bsandbox\b/i,
  /\b(?:vstest|testhost)\b/i,
  /loopback/i,
  /test artifacts/i,
  /\bbwrap\b/i,
  /no permissions to create a new namespace/i,
  /(?:відсутн\w*|немає|не встановлен\w*|missing|not (?:found|installed))[^.\n]{0,60}\.net sdk/i,
  /\.net sdk[^.\n]{0,60}(?:відсутн\w*|немає|не встановлен\w*|missing|not (?:found|installed))/i,
  /dotnet[^.\n]{0,40}(?:command not found|not found|немає|відсутн\w*)/i,
]

export function isSandboxLimitedReview(task) {
  const run = task.agentRun
  if (!run || run.status !== 'needs_review') return false
  const text = `${run.summary ?? ''}\n${run.error ?? ''}`
  return SANDBOX_LIMIT_PATTERNS.some((pattern) => pattern.test(text))
}

export function isSentinelTask(task) {
  return SENTINEL_MARKER.test(task.notes ?? '') || /^\[AUTO\]/.test(task.title ?? '')
}

export function releaseStatusFor(task) {
  return isSentinelTask(task) ? 'done' : undefined
}

export function selectReleasableTasks(tasks) {
  const priority = { processing: 0, retrying: 1, pending: 2, '': 3 }
  return tasks.filter((task) =>
    (task.agentRun?.status === 'completed' || isSandboxLimitedReview(task)) &&
    (task.agentRun?.releaseStatus
      ? ['pending', 'processing', 'retrying'].includes(task.agentRun.releaseStatus)
      : hasWorkNewerThanGate(task)) &&
    task.status !== 'done')
    .sort((left, right) => {
      const byRelease = (priority[left.agentRun?.releaseStatus ?? ''] ?? 4)
        - (priority[right.agentRun?.releaseStatus ?? ''] ?? 4)
      if (byRelease !== 0) return byRelease
      return Date.parse(left.agentRun?.finishedAt ?? left.agentRun?.updatedAt ?? 0)
        - Date.parse(right.agentRun?.finishedAt ?? right.agentRun?.updatedAt ?? 0)
    })
}

export function parseUnitStates(output) {
  const units = {}
  let currentId = null
  for (const line of (output ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('Id=')) {
      currentId = trimmed.slice(3)
      continue
    }
    if (trimmed.startsWith('ActiveState=') && currentId) {
      units[currentId] = trimmed.slice('ActiveState='.length)
      currentId = null
    }
  }
  return units
}

export function parseComposePs(output) {
  const trimmed = (output ?? '').trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return trimmed.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{') || line.startsWith('['))
      .flatMap((line) => {
        const parsed = JSON.parse(line)
        return Array.isArray(parsed) ? parsed : [parsed]
      })
  }
}

export function isRetryableValidation(check, result) {
  const command = check.join(' ')
  if (!/(?:^|\s)(?:test|vitest)(?:\s|$)/i.test(command)) return false
  return result.timedOut === true || [
    /timing flake/i,
    /ConsumerTimeout_ReleasesLease/i,
    /StartupRecovery_RetriesTimeout/i,
    /test timed out/i,
    /worker exited unexpectedly/i,
  ].some((pattern) => pattern.test(result.output ?? ''))
}

export function checkCommand(check) {
  return Array.isArray(check) ? check : check.command
}

export function selectRepositoryChecks(plan, changedFiles = []) {
  const unconditional = plan.checks.filter(Array.isArray)
  const conditional = plan.checks.filter((check) => !Array.isArray(check))
  if (conditional.length === 0 || changedFiles.length === 0) return plan.checks.map(checkCommand)

  const matched = conditional.filter((check) => changedFiles.some((file) =>
    check.paths.some((pathPattern) => file.includes(pathPattern))))
  const sourceOrTestChanged = changedFiles.some((file) => /^(?:src|tests)\//.test(file))
  // Невідомий source-контур не можна тихо лишити без тестів: у такому разі
  // повертаємо повний набір. Вибірковість дозволена лише для відомої мапи.
  if (sourceOrTestChanged && matched.length === 0) return plan.checks.map(checkCommand)
  return [...unconditional, ...matched].map(checkCommand)
}

export function validationGateFingerprint(repo, validatedCommit, files, checks) {
  return createHash('sha256').update(JSON.stringify({
    version: 2,
    repo,
    validatedCommit,
    files: [...files].sort(),
    checks,
  })).digest('hex')
}

function mergeEvidence(current, patch) {
  const left = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
  const right = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const merged = { ...left }
  for (const [key, value] of Object.entries(right)) {
    merged[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeEvidence(left[key], value)
      : value
  }
  return merged
}

function readAgentReleasePlan(task) {
  try {
    const details = JSON.parse(task.agentRun?.details ?? '{}')
    return details?.releasePlan && typeof details.releasePlan === 'object' ? details.releasePlan : {}
  } catch {
    return {}
  }
}

export function isMigrationFile(repo, file) {
  if (repo !== 'gba-server') return /(?:^|\/)(?:migrations?|database-migrations?)(?:\/|[^/]*\.(?:cs|sql)$)/i.test(file)
  return /(?:^|\/)Migrations\//.test(file)
    || /(?:^|\/)scripts\/[^/]*migrat[^/]*\.(?:sh|sql)$/i.test(file)
}

function sameStringSet(left, right) {
  const a = [...new Set(left)].sort()
  const b = [...new Set(right)].sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function validateSmokeCheck(check) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return 'live-check має бути об’єктом'
  if (typeof check.label !== 'string' || !check.label.trim() || check.label.length > 200) return 'live-check має короткий label'
  if (!Number.isInteger(check.expectedStatus) || check.expectedStatus < 100 || check.expectedStatus > 599) return `${check.label}: невалідний expectedStatus`
  if (typeof check.contains !== 'string' || check.contains.length > 500) return `${check.label}: contains має бути рядком до 500 символів`
  let url
  try {
    url = new URL(check.url)
  } catch {
    return `${check.label}: невалідний URL`
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return `${check.label}: дозволений лише http(s) URL без credentials`
  const allowedHost = ['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.hostname.endsWith('.85.17.167.167.nip.io')
  if (!allowedHost) return `${check.label}: host не входить до DEV allowlist`
  return ''
}

export function validateReleaseHandoff(handoff, repos, services, repositoryEvidence, repoPlan) {
  if (!handoff || !Array.isArray(handoff.repositories)) {
    return {
      ok: false,
      reason: 'releasePlan відсутній або застарілий; потрібен новий Codex-прогін із явними repos/migrations/services/live-checks',
    }
  }
  for (const field of ['repositories', 'migrationFiles', 'services', 'postDeployChecks']) {
    if (!Array.isArray(handoff[field])) return { ok: false, reason: `releasePlan.${field} має бути масивом` }
  }
  if (!sameStringSet(handoff.repositories, repos)) {
    return { ok: false, reason: `releasePlan.repositories не збігається з git: declared=${handoff.repositories.join(',')} actual=${repos.join(',')}` }
  }
  const declaredServices = [...new Set(handoff.services)]
  const unexpectedServices = declaredServices.filter((service) => !services.includes(service))
  if (unexpectedServices.length > 0) {
    return {
      ok: false,
      reason: `releasePlan.services містить сервіси поза repo plan: declared=${handoff.services.join(',')} actual=${services.join(',')} unexpected=${unexpectedServices.join(',')}`,
    }
  }
  const autoAddedServices = services.filter((service) => !declaredServices.includes(service))
  const actualMigrations = repos.flatMap((repo) =>
    (repositoryEvidence?.[repo]?.files ?? [])
      .filter((file) => isMigrationFile(repo, file))
      .map((file) => `${repo}:${file}`))
  if (!sameStringSet(handoff.migrationFiles, actualMigrations)) {
    return { ok: false, reason: `releasePlan.migrationFiles не збігається з git: declared=${handoff.migrationFiles.join(',')} actual=${actualMigrations.join(',')}` }
  }
  for (const migration of actualMigrations) {
    const repo = migration.slice(0, migration.indexOf(':'))
    if (!repoPlan[repo]?.migration) return { ok: false, reason: `${repo}: знайдено міграцію, але немає штатного migration runner` }
  }
  if (handoff.postDeployChecks.length === 0) return { ok: false, reason: 'releasePlan.postDeployChecks порожній' }
  for (const check of handoff.postDeployChecks) {
    const error = validateSmokeCheck(check)
    if (error) return { ok: false, reason: error }
  }
  return {
    ok: true,
    legacy: false,
    checks: handoff.postDeployChecks,
    migrations: actualMigrations,
    declaredServices,
    effectiveServices: [...services],
    autoAddedServices,
  }
}

function terminateProcessTree(child, signal) {
  if (!child?.pid) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // Процес уже завершився.
  }
}

function waitForProcessExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('close', onExit)
      child.removeListener('error', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    child.once('close', onExit)
    child.once('error', onExit)
    timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
  })
}

function runProcess(command, args, { cwd, timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS, env = process.env, onChild } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    onChild?.(child)
    let output = ''
    let timedOut = false
    child.stdout.on('data', (chunk) => { output = (output + chunk.toString()).slice(-20000) })
    child.stderr.on('data', (chunk) => { output = (output + chunk.toString()).slice(-20000) })
    child.on('error', (error) => resolve({ code: 1, output: String(error) }))
    const timeout = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child, 'SIGTERM')
      setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 5_000).unref?.()
    }, timeoutMs)
    timeout.unref?.()
    child.on('close', (code) => {
      clearTimeout(timeout)
      resolve({ code: code ?? 1, output, timedOut })
    })
  })
}

async function pathExists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

export class ReleaseWorker {
  constructor({
    deskBaseUrl = process.env.RELEASE_DESK_URL ?? 'http://127.0.0.1:4000',
    worktreesDirectory = process.env.CODEX_WORKTREES_DIR ?? '/root/projects/gba-bug-worktrees',
    infraDirectory = process.env.RELEASE_INFRA_DIR ?? '/root/projects/gba-infra',
    repoPlan = defaultRepoPlan,
    pollIntervalMs = Number.parseInt(process.env.RELEASE_POLL_INTERVAL_MS ?? '30000', 10),
    settleMs = Number.parseInt(process.env.RELEASE_SETTLE_MS ?? '180000', 10),
    heartbeatIntervalMs = Number.parseInt(process.env.RELEASE_HEARTBEAT_INTERVAL_MS ?? '30000', 10),
    leaseName = process.env.RELEASE_WORKER_LEASE_NAME ?? 'release-worker',
    leaseTtlMs = Number.parseInt(process.env.RELEASE_WORKER_LEASE_TTL_MS ?? '120000', 10),
    workerId = randomUUID(),
    processRunner = runProcess,
    internalApiToken = process.env.QA_DESK_INTERNAL_API_TOKEN ?? '',
    probes = serviceProbes,
  } = {}) {
    this.deskBaseUrl = deskBaseUrl.replace(/\/$/, '')
    this.worktreesDirectory = worktreesDirectory
    this.infraDirectory = infraDirectory
    this.repoPlan = repoPlan
    this.pollIntervalMs = pollIntervalMs
    this.settleMs = settleMs
    this.heartbeatIntervalMs = heartbeatIntervalMs
    this.leaseName = leaseName
    this.leaseTtlMs = leaseTtlMs
    this.workerId = workerId
    this.runProcess = processRunner
    this.internalApiToken = internalApiToken
    this.probes = probes
    this.busy = false
    this.leaseStarted = false
    this.leaseHeld = false
    this.activeMutationChild = null
    this.stopped = false
    this.firstSeenAt = new Map()
  }

  requestHeaders(additional = {}) {
    return {
      ...(this.internalApiToken ? { Authorization: `Bearer ${this.internalApiToken}` } : {}),
      ...additional,
    }
  }

  start() {
    this.stopped = false
    this.leaseStarted = true
    setInterval(() => void this.tick(), this.pollIntervalMs)
    void this.tick()
    setInterval(() => void this.heartbeatLease(), this.heartbeatIntervalMs)
    setInterval(() => void this.reportHostUnits(), this.heartbeatIntervalMs)
    void this.reportHostUnits()
    console.log('[release] воркер запущено: completed → preflight → merge/push → migrations → deploy → health')
  }

  async acquireLease() {
    if (!this.leaseStarted) return true
    const response = await fetch(`${this.deskBaseUrl}/api/system/worker-leases/${encodeURIComponent(this.leaseName)}/acquire`, {
      method: 'POST',
      headers: this.requestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ownerId: this.workerId, ttlMs: this.leaseTtlMs }),
    }).catch(() => null)
    this.leaseHeld = response?.ok === true
    return this.leaseHeld
  }

  async heartbeatLease() {
    if (this.stopped || !this.leaseStarted || !this.leaseHeld) return false
    const response = await fetch(`${this.deskBaseUrl}/api/system/worker-leases/${encodeURIComponent(this.leaseName)}/heartbeat`, {
      method: 'POST',
      headers: this.requestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ownerId: this.workerId }),
    }).catch(() => null)
    this.leaseHeld = response?.ok === true
    if (!this.leaseHeld) {
      // Після takeover інший owner уже має право мутувати ті самі mainline/DEV
      // ресурси, тому тут немає безпечного grace-period для старого процесу.
      if (this.activeMutationChild) terminateProcessTree(this.activeMutationChild, 'SIGKILL')
      console.error('[release] lease втрачено; активну мутацію зупинено')
    }
    return this.leaseHeld
  }

  async assertLease() {
    if (!this.leaseStarted) return
    if (!this.leaseHeld || !await this.heartbeatLease()) {
      throw new Error('release-worker втратив singleton lease')
    }
  }

  async runMutation(command, args, options = {}) {
    await this.assertLease()
    let child = null
    try {
      return await this.runProcess(command, args, {
        ...options,
        onChild: (spawned) => {
          child = spawned
          this.activeMutationChild = spawned
          options.onChild?.(spawned)
        },
      })
    } finally {
      if (this.activeMutationChild === child) this.activeMutationChild = null
    }
  }

  async stop() {
    this.stopped = true
    const child = this.activeMutationChild
    if (child) {
      terminateProcessTree(child, 'SIGTERM')
      let exited = await waitForProcessExit(child, 5_000)
      if (!exited) {
        terminateProcessTree(child, 'SIGKILL')
        exited = await waitForProcessExit(child, 30_000)
      }
      if (!exited) {
        // Не віддаємо lease явно, доки стара mutation не підтвердила exit.
        // Після аварійного завершення процесу takeover все одно зачекає TTL.
        console.error('[release] mutation child не завершився після SIGKILL; lease лишено до TTL')
        return false
      }
      if (this.activeMutationChild === child) this.activeMutationChild = null
    }
    if (this.leaseStarted && this.leaseHeld) {
      await fetch(`${this.deskBaseUrl}/api/system/worker-leases/${encodeURIComponent(this.leaseName)}`, {
        method: 'DELETE',
        headers: this.requestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ownerId: this.workerId }),
      }).catch(() => undefined)
    }
    this.leaseHeld = false
    return true
  }

  async reportHostUnits() {
    // Список юнітів диктує інвентар дески: systemctl-глоб бачить лише завантажені
    // юніти, тож вимкнений таймер через глоб просто зникає замість «inactive».
    const wanted = await fetch(`${this.deskBaseUrl}/api/system/units`, { headers: this.requestHeaders() })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => payload?.units ?? [])
      .catch(() => [])
    if (wanted.length === 0) return

    const shown = await this.runProcess(
      'systemctl',
      ['show', '--no-pager', '--property=Id', '--property=ActiveState', ...wanted],
      {},
    )
    if (shown.code !== 0) return
    const units = parseUnitStates(shown.output)
    if (Object.keys(units).length === 0) return
    await fetch(`${this.deskBaseUrl}/api/system/heartbeat`, {
      method: 'POST',
      headers: this.requestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ units, host: 'gba-host' }),
    }).catch((error) => console.error(`[release] heartbeat: ${error.message}`))
  }

  async tick() {
    if (this.stopped || this.busy) return
    if (!this.leaseHeld && !await this.acquireLease()) return
    this.busy = true
    try {
      const response = await fetch(`${this.deskBaseUrl}/api/tasks`, { headers: this.requestHeaders() })
      if (!response.ok) throw new Error(`desk → ${response.status}`)
      const tasks = await response.json()
      await this.recoverReleasedWorktreeCleanup(tasks)
      const candidates = selectReleasableTasks(tasks)
      if (candidates.length === 0) {
        this.firstSeenAt.clear()
        return
      }

      const now = Date.now()
      const candidateIds = new Set(candidates.map((task) => task.id))
      for (const taskId of this.firstSeenAt.keys()) {
        if (!candidateIds.has(taskId)) this.firstSeenAt.delete(taskId)
      }
      for (const task of candidates) {
        if (!this.firstSeenAt.has(task.id)) this.firstSeenAt.set(task.id, now)
      }
      const ready = candidates.filter((task) => now - this.firstSeenAt.get(task.id) >= this.settleMs)
      if (ready.length === 0) return

      // Release queue is deliberately single-task. A multi-repository task may
      // need a recovery pass after one remote accepted a push; shipping another
      // task meanwhile could deploy that partial state.
      await this.releaseBatch([ready[0]])
      this.firstSeenAt.delete(ready[0].id)
    } catch (error) {
      console.error(`[release] tick: ${error.message}`)
    } finally {
      this.busy = false
    }
  }

  async releaseBatch(tasks) {
    const task = tasks[0]
    if (!task) return
    await this.assertLease()
    const outcome = await this.releaseTask(task)
    if (!outcome.ok) {
      await this.handleReleaseFailure(task, outcome)
      return
    }

    const repos = [...new Set(outcome.repos)]
    const services = [...new Set(repos.flatMap((repo) => this.repoPlan[repo]?.services ?? []))]
    if (repos.length === 0 || services.length === 0) {
      await this.handleReleaseFailure(task, {
        kind: 'repository',
        reason: 'Release не має доведеного репозиторію або DEV-сервісу; статус released заборонено.',
      })
      return
    }

    const handoff = readAgentReleasePlan(task)
    const handoffValidation = validateReleaseHandoff(
      handoff,
      repos,
      services,
      outcome.repositoryEvidence,
      this.repoPlan,
    )
    if (!handoffValidation.ok) {
      await this.handleReleaseFailure(task, {
        kind: 'validation',
        phase: 'preflight',
        reason: handoffValidation.reason,
      })
      return
    }
    let evidence = mergeEvidence(task.agentRun?.releaseEvidence, {
      repositories: outcome.repositoryEvidence,
      services,
      handoff,
      handoffConsistency: {
        legacy: handoffValidation.legacy,
        matches: true,
        migrations: handoffValidation.migrations,
        declaredServices: handoffValidation.declaredServices,
        effectiveServices: handoffValidation.effectiveServices,
        autoAddedServices: handoffValidation.autoAddedServices,
      },
    })

    const publishedBeforeMigration = await this.verifyPublishedWorktrees(repos, outcome.repositoryEvidence)
    if (!publishedBeforeMigration.ok) {
      await this.handleReleaseFailure(task, {
        kind: 'transient',
        phase: 'migrating',
        reason: publishedBeforeMigration.reason,
        evidence,
      })
      return
    }

    await this.updateRelease(task, {
      status: 'processing',
      phase: 'migrating',
      repositories: repos,
      error: '',
      evidence,
    })
    await this.assertLease()
    const migrations = await this.runRequiredMigrations(task, repos, outcome.repositoryEvidence)
    evidence = mergeEvidence(evidence, { migrations: migrations.evidence })
    if (!migrations.ok) {
      await this.handleReleaseFailure(task, {
        kind: migrations.kind,
        reason: migrations.reason,
        phase: 'migrating',
        evidence,
      })
      return
    }

    const publishedBeforeBuild = await this.verifyPublishedWorktrees(repos, outcome.repositoryEvidence)
    if (!publishedBeforeBuild.ok) {
      await this.handleReleaseFailure(task, {
        kind: 'transient',
        phase: 'deploying',
        reason: publishedBeforeBuild.reason,
        evidence,
      })
      return
    }

    const expectedCommits = Object.fromEntries(repos.flatMap((repo) =>
      (this.repoPlan[repo]?.services ?? []).map((service) => [service, outcome.repositoryEvidence?.[repo]?.commit ?? ''])))
    const before = await this.captureDeployment(services)
    let verification = await this.verifyDeployment(services, before, expectedCommits)
    let composeOutput = 'Exact immutable deployment was already healthy; rebuild/recreate skipped.'

    if (!verification.ok) {
      await this.updateRelease(task, {
        status: 'processing',
        phase: 'deploying',
        evidence,
      })
      await this.assertLease()
      const deploymentEnvironment = this.deploymentEnvironment(outcome.repositoryEvidence)
      const deploy = await this.runMutation(
        'docker',
        [...COMPOSE_ARGS, 'up', '-d', '--build', '--no-deps', '--wait', '--wait-timeout', '420', ...services],
        { cwd: this.infraDirectory, timeoutMs: 60 * 60 * 1000, env: deploymentEnvironment },
      )
      if (deploy.code !== 0) {
        await this.handleReleaseFailure(task, {
          kind: 'transient',
          reason: `Деплой не пройшов${deploy.timedOut ? ' (timeout)' : ''}: ${deploy.output.slice(-1000)}`,
          phase: 'deploying',
          evidence,
        })
        return
      }

      composeOutput = deploy.output.slice(-2000)
      verification = await this.verifyDeployment(services, before, expectedCommits)
    }

    await this.updateRelease(task, {
      status: 'processing',
      phase: 'verifying',
      evidence,
    })
    await this.assertLease()
    const repositoryCommits = Object.fromEntries(
      repos.map((repo) => [repo, outcome.repositoryEvidence?.[repo]?.commit ?? '']),
    )
    evidence = mergeEvidence(evidence, {
      deployment: {
        services: verification.services ?? {},
        repositoryCommits,
        verifiedAt: new Date().toISOString(),
        composeOutput,
      },
    })
    if (!verification.ok) {
      await this.handleReleaseFailure(task, {
        kind: 'transient',
        reason: verification.reason,
        phase: 'verifying',
        evidence,
      })
      return
    }
    const scenario = await this.verifyPostDeployChecks(handoffValidation.checks)
    evidence = mergeEvidence(evidence, { scenarioChecks: scenario.evidence })
    if (!scenario.ok) {
      await this.handleReleaseFailure(task, {
        kind: scenario.kind ?? 'transient',
        reason: scenario.reason,
        phase: 'verifying',
        evidence,
      })
      return
    }
    // Crash-safe checkpoint: якщо процес упаде під час cleanup/final status,
    // наступний власник бачить точний commit→image/container proof.
    await this.updateRelease(task, {
      status: 'processing',
      phase: 'verifying',
      evidence,
    })

    const stamp = new Date().toISOString()
    const releaseTaskStatus = releaseStatusFor(task)
    const taskStatus = releaseTaskStatus ?? task.status
    const closing = releaseTaskStatus === 'done'
    const cleanupErrors = await this.cleanupReleasedWorktrees(task)
    await this.annotate(task, [
      `[released:${stamp}] merge/push, міграції, rebuild і live health підтверджені`,
      cleanupErrors.length > 0 ? `[release-cleanup-warning] ${cleanupErrors.join('; ')}` : '',
      closing ? '[auto-closed] лог-задача: фікс у мейнлайні й на dev; якщо помилка повториться — вартовий заведе нову' : '',
    ].filter(Boolean).join('\n').slice(0, 1200))
    await this.updateRelease(task, {
      status: 'released',
      phase: 'released',
      error: '',
      evidence,
      releasedAt: stamp,
      taskStatus,
    })
    console.log(`[release] ${task.id}: випущено з міграційним і live доказом${closing ? ' та закрито' : ''}`)
  }

  async handleReleaseFailure(task, outcome) {
    const attempts = (task.agentRun?.releaseAttempts ?? 0) + 1
    const deterministic = ['conflict', 'validation', 'repository'].includes(outcome.kind)
    const evidence = mergeEvidence(outcome.evidence ?? task.agentRun?.releaseEvidence, {
      failure: {
        phase: outcome.phase ?? task.agentRun?.releasePhase ?? 'failed',
        reason: outcome.reason,
        at: new Date().toISOString(),
      },
    })
    if (deterministic && attempts >= MAX_RELEASE_ATTEMPTS) {
      const stamp = new Date().toISOString()
      await this.updateRelease(task, {
        status: 'blocked',
        phase: 'failed',
        attempts,
        error: outcome.reason,
        evidence,
        taskStatus: isSentinelTask(task) ? 'blocked' : task.status,
      })
      await this.annotate(task, `[release-blocked:${stamp}] ${attempts} невдалих спроб на фазі ${outcome.phase ?? 'release'}: ${outcome.reason}.`.slice(0, 700))
      console.error(`[release] ${task.id}: заблоковано після ${attempts} спроб — ${outcome.reason.slice(0, 160)}`)
      return
    }
    await this.updateRelease(task, {
      status: 'retrying',
      phase: 'failed',
      attempts,
      error: outcome.reason,
      evidence,
    })
    await this.annotate(task, `[release-retry] фаза ${outcome.phase ?? 'release'}: ${outcome.reason}`.slice(0, 700))
    console.error(`[release] ${task.id}: ${outcome.reason.slice(0, 200)}`)
  }

  async runRequiredMigrations(task, repos, repositoryEvidence) {
    const migrationEvidence = { required: [], applied: {} }
    for (const repo of repos) {
      const migration = this.repoPlan[repo]?.migration
      if (!migration) continue
      migrationEvidence.required.push(repo)
      const commit = repositoryEvidence?.[repo]?.commit ?? ''
      // Migrator є ідемпотентним і мусить підтверджувати поточну БД на кожній
      // release-спробі. Commit-доказ не доводить стан схеми: між retry DEV БД
      // могли reset/restore/replace. Повторно використовуємо лише green test
      // gate, але ніколи не mutation proof БД.
      const result = await this.runMutation(migration.command, migration.args, {
        cwd: this.repoPlan[repo].root,
        timeoutMs: migration.timeoutMs,
      })
      migrationEvidence.applied[repo] = {
        ok: result.code === 0,
        commit,
        completedAt: new Date().toISOString(),
        output: result.output.slice(-3000),
      }
      if (result.code !== 0) {
        const deterministic = /pending model changes|target migration.+not found|must be true or false|secrets directory not found|connection string secret not found|build failed/i.test(result.output)
        return {
          ok: false,
          kind: deterministic ? 'validation' : 'transient',
          evidence: migrationEvidence,
          reason: `${repo}: штатний migrator не пройшов${result.timedOut ? ' (timeout)' : ''}: ${result.output.slice(-1000)}`,
        }
      }
    }
    return { ok: true, evidence: migrationEvidence }
  }

  deploymentEnvironment(repositoryEvidence) {
    const env = { ...process.env }
    for (const [repo, variable] of Object.entries(REPOSITORY_SHA_ENV)) {
      const commit = repositoryEvidence?.[repo]?.commit
      if (commit) env[variable] = commit
    }
    return env
  }

  async verifyPublishedWorktrees(repos, repositoryEvidence) {
    for (const repo of repos) {
      const plan = this.repoPlan[repo]
      const expectedCommit = repositoryEvidence?.[repo]?.commit ?? ''
      if (!plan || !expectedCommit) return { ok: false, reason: `${repo}: немає published SHA для build context` }
      const checkedOut = await this.runProcess('git', ['-C', plan.root, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {})
      if (checkedOut.code !== 0 || checkedOut.output.trim() !== plan.branch) {
        return { ok: false, reason: `${repo}: build context не на ${plan.branch}` }
      }
      const head = await this.runProcess('git', ['-C', plan.root, 'rev-parse', 'HEAD'], {})
      const actualCommit = /\b[0-9a-f]{40}\b/.exec(head.output)?.[0] ?? ''
      if (actualCommit !== expectedCommit) {
        return { ok: false, reason: `${repo}: build context ${actualCommit || 'unknown'} не дорівнює published ${expectedCommit}` }
      }
      const dirty = await this.runProcess('git', ['-C', plan.root, 'status', '--porcelain'], {})
      if (dirty.code !== 0 || dirty.output.split('\n').some((line) => line.trim())) {
        return { ok: false, reason: `${repo}: build context має незакомічені/невідомі зміни` }
      }
    }
    return { ok: true }
  }

  async captureDeployment(services) {
    const result = await this.runProcess(
      'docker',
      [...COMPOSE_ARGS, 'ps', '--format', 'json', ...services],
      { cwd: this.infraDirectory, timeoutMs: 60_000 },
    )
    if (result.code !== 0) return {}
    try {
      return Object.fromEntries(parseComposePs(result.output).map((item) => [item.Service, item]))
    } catch {
      return {}
    }
  }

  async verifyDeployment(services, before, expectedCommits) {
    const current = await this.captureDeployment(services)
    const proof = {}
    for (const service of services) {
      const container = current[service]
      if (!container) return { ok: false, reason: `${service}: контейнер відсутній після deploy`, services: proof }
      if (container.State !== 'running') {
        return { ok: false, reason: `${service}: state=${container.State ?? 'unknown'}`, services: proof }
      }
      if (container.Health && container.Health !== 'healthy') {
        return { ok: false, reason: `${service}: health=${container.Health}`, services: proof }
      }
      const probe = this.probes[service]
      if (!probe) return { ok: false, reason: `${service}: не налаштована live-перевірка`, services: proof }
      const live = await this.runProcess(
        'curl',
        ['-fsS', '--max-time', '20', '--retry', '2', '--retry-delay', '2', '-o', '/dev/null', probe],
        { timeoutMs: 60_000 },
      )
      if (live.code !== 0) {
        return { ok: false, reason: `${service}: live probe ${probe} не пройшов`, services: proof }
      }
      const expectedCommit = expectedCommits[service]
      const containerImage = await this.runProcess(
        'docker',
        ['inspect', '--type', 'container', '--format', '{{.Image}}', container.ID],
        { timeoutMs: 60_000 },
      )
      const imageDigest = containerImage.output.trim()
      if (containerImage.code !== 0 || !/^sha256:[0-9a-f]{64}$/i.test(imageDigest)) {
        return { ok: false, reason: `${service}: не вдалося довести immutable image ID`, services: proof }
      }
      const imageInspection = await this.runProcess(
        'docker',
        ['image', 'inspect', '--format', '{{json .Config.Labels}}', imageDigest],
        { timeoutMs: 60_000 },
      )
      let imageLabels = {}
      try {
        imageLabels = JSON.parse(imageInspection.output.trim()) ?? {}
      } catch {
        imageLabels = {}
      }
      const imageCommit = imageLabels['gba.git.sha'] ?? ''
      if (imageInspection.code !== 0 || !expectedCommit || imageCommit !== expectedCommit) {
        return {
          ok: false,
          reason: `${service}: immutable image commit ${imageCommit || 'відсутній'} не збігається з published ${expectedCommit || 'відсутній'}`,
          services: proof,
        }
      }
      proof[service] = {
        containerId: container.ID,
        image: container.Image,
        imageDigest,
        imageCommit,
        replaced: before?.[service]?.ID !== container.ID,
        state: container.State,
        health: container.Health || 'live-probe',
        probe,
      }
    }
    return { ok: true, services: proof }
  }

  async verifyPostDeployChecks(checks) {
    const evidence = []
    for (const check of checks) {
      const result = await this.runProcess(
        'curl',
        ['-sS', '--max-time', '20', '--retry', '2', '--retry-delay', '2', '-w', '\n%{http_code}', check.url],
        { timeoutMs: 60_000 },
      )
      const split = result.output.lastIndexOf('\n')
      const body = split >= 0 ? result.output.slice(0, split) : ''
      const status = Number.parseInt(split >= 0 ? result.output.slice(split + 1).trim() : '', 10)
      const expectedContent = check.contains?.toLocaleLowerCase() ?? ''
      const passed = result.code === 0
        && status === check.expectedStatus
        && (!expectedContent || body.toLocaleLowerCase().includes(expectedContent))
      evidence.push({
        label: check.label,
        url: check.url,
        expectedStatus: check.expectedStatus,
        actualStatus: Number.isInteger(status) ? status : null,
        contains: check.contains,
        passed,
      })
      if (!passed) {
        return {
          ok: false,
          kind: classifyPostDeployCheckFailure({ code: result.code, status }),
          reason: `live-check «${check.label}» не пройшов`,
          evidence,
        }
      }
    }
    return { ok: true, evidence }
  }

  async releaseTask(task) {
    const slug = taskSlug(task.id)
    const branch = branchName(task.id)
    const jobDirectory = path.join(this.worktreesDirectory, slug)
    const persistedRepos = new Set(task.agentRun?.releaseRepositories ?? [])
    const selected = new Map()
    let evidence = task.agentRun?.releaseEvidence ?? {}

    for (const [repo, plan] of Object.entries(this.repoPlan)) {
      const worktree = path.join(jobDirectory, repo)
      const hasWorktree = await pathExists(path.join(worktree, '.git'))
      if (!hasWorktree) {
        if (!persistedRepos.has(repo)) continue
        const branchExists = await this.runProcess('git', ['-C', plan.root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {})
        if (branchExists.code === 0) {
          const ancestor = await this.runProcess('git', ['-C', plan.root, 'merge-base', '--is-ancestor', branch, plan.branch], {})
          if (ancestor.code === 0) {
            selected.set(repo, { mode: 'already', worktree, files: evidence?.repositories?.[repo]?.files ?? [] })
            continue
          }
        }
        const recordedCommit = evidence?.repositories?.[repo]?.commit
        if (recordedCommit) {
          const recorded = await this.runProcess('git', ['-C', plan.root, 'merge-base', '--is-ancestor', recordedCommit, plan.branch], {})
          if (recorded.code === 0) {
            selected.set(repo, { mode: 'already', worktree, files: evidence?.repositories?.[repo]?.files ?? [] })
            continue
          }
        }
        return { ok: false, kind: 'repository', phase: 'preflight', reason: `${repo}: release-state є, але worktree/доказаний commit втрачено` }
      }

      const status = await this.runProcess('git', ['-C', worktree, 'status', '--porcelain'], {})
      if (status.output.split('\n').some((line) => line.trim())) {
        const stage = await this.runMutation('git', ['-C', worktree, 'add', '-A'], {})
        if (stage.code !== 0) return { ok: false, kind: 'repository', reason: `stage у ${repo}: ${stage.output.slice(-200)}` }
        const commit = await this.runMutation('git', ['-C', worktree, 'commit', '-m', `fix: ${task.title.slice(0, 90)} (${task.id})\n\nCo-Authored-By: Codex via GBA QA Desk`], {})
        if (commit.code !== 0) return { ok: false, kind: 'repository', reason: `commit у ${repo}: ${commit.output.slice(-200)}` }
      }

      const unique = await this.runProcess(
        'git',
        ['-C', plan.root, 'log', '--cherry-pick', '--right-only', '--no-merges', '--format=%H', `${plan.branch}...${branch}`],
        {},
      )
      if (unique.code !== 0) return { ok: false, kind: 'repository', reason: `${repo}: не вдалося порівняти ${branch} із ${plan.branch}` }
      if (unique.output.trim()) {
        const base = await this.runProcess('git', ['-C', plan.root, 'merge-base', plan.branch, branch], {})
        const files = base.code === 0
          ? await this.runProcess('git', ['-C', plan.root, 'diff', '--name-only', base.output.trim(), branch], {})
          : { code: 1, output: '' }
        selected.set(repo, {
          mode: 'candidate',
          worktree,
          files: files.code === 0 ? files.output.split('\n').map((file) => file.trim()).filter(Boolean) : [],
        })
        continue
      }

      const alreadyMerged = await this.runProcess(
        'git',
        ['-C', plan.root, 'merge-base', '--is-ancestor', branch, plan.branch],
        {},
      )
      if (alreadyMerged.code === 0 && persistedRepos.has(repo)) {
        selected.set(repo, { mode: 'already', worktree, files: evidence?.repositories?.[repo]?.files ?? [] })
        continue
      }
      if (![0, 1].includes(alreadyMerged.code)) {
        return { ok: false, kind: 'repository', phase: 'preflight', reason: `${repo}: не вдалося перевірити, чи ${branch} уже в mainline` }
      }

      // Patch-equivalent cherry-pick не є git-ancestor. Доводимо, що task-гілка
      // справді мала власні коміти; гілка, створена й покинута без змін, не може
      // перетворитися на false-positive release.
      const mergeBase = await this.runProcess('git', ['-C', plan.root, 'merge-base', plan.branch, branch], {})
      if (mergeBase.code === 0 && mergeBase.output.trim()) {
        const count = await this.runProcess('git', ['-C', plan.root, 'rev-list', '--count', `${mergeBase.output.trim()}..${branch}`], {})
        const changed = await this.runProcess('git', ['-C', plan.root, 'diff', '--name-only', mergeBase.output.trim(), branch], {})
        if (count.code === 0 && Number.parseInt(count.output.trim(), 10) > 0 && changed.code === 0 && changed.output.trim()) {
          selected.set(repo, {
            mode: 'patch-equivalent',
            worktree,
            files: changed.output.split('\n').map((file) => file.trim()).filter(Boolean),
          })
        }
      }
    }

    if (selected.size === 0) {
      return {
        ok: false,
        kind: 'repository',
        phase: 'preflight',
        reason: 'Codex повернув fixed, але жодного реального коміту/репозиторію не знайдено.',
      }
    }
    const touchedRepos = [...selected.keys()]
    const services = [...new Set(touchedRepos.flatMap((repo) => this.repoPlan[repo]?.services ?? []))]
    const handoff = readAgentReleasePlan(task)
    const selectedFileEvidence = Object.fromEntries([...selected].map(([repo, selection]) => [repo, {
      files: selection.files,
    }]))
    const handoffValidation = validateReleaseHandoff(
      handoff,
      touchedRepos,
      services,
      selectedFileEvidence,
      this.repoPlan,
    )
    if (!handoffValidation.ok) {
      return {
        ok: false,
        kind: 'validation',
        phase: 'preflight',
        reason: handoffValidation.reason,
        evidence,
      }
    }
    evidence = mergeEvidence(evidence, {
      services,
      handoff,
      handoffConsistency: {
        legacy: handoffValidation.legacy,
        matches: true,
        migrations: handoffValidation.migrations,
        declaredServices: handoffValidation.declaredServices,
        effectiveServices: handoffValidation.effectiveServices,
        autoAddedServices: handoffValidation.autoAddedServices,
      },
    })
    await this.updateRelease(task, {
      status: 'processing',
      phase: 'preflight',
      repositories: touchedRepos,
      error: '',
      evidence,
    })

    const prepared = []
    for (const repo of touchedRepos) {
      const plan = this.repoPlan[repo]
      if (!plan) return { ok: false, kind: 'repository', reason: `Невідомий репозиторій у release-state: ${repo}` }
      const selection = selected.get(repo)
      const worktree = selection.worktree

      const checkedOut = await this.runProcess('git', ['-C', plan.root, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {})
      if (checkedOut.code !== 0 || checkedOut.output.trim() !== plan.branch) {
        return {
          ok: false,
          kind: 'repository',
          phase: 'preflight',
          reason: `${repo}: main worktree має бути на ${plan.branch}, зараз ${checkedOut.output.trim() || 'detached/unknown'}`,
        }
      }
      const dirty = await this.runProcess('git', ['-C', plan.root, 'status', '--porcelain'], {})
      if (dirty.output.split('\n').some((line) => line.trim())) {
        return { ok: false, kind: 'transient', reason: `${repo}: у робочому дереві є незакомічені зміни — відкладено` }
      }

      const baseline = await this.runProcess('git', ['-C', plan.root, 'rev-parse', 'HEAD'], {})
      const baselineCommit = /\b[0-9a-f]{40}\b/.exec(baseline.output)?.[0]
      if (!baselineCommit) return { ok: false, kind: 'repository', reason: `${repo}: не вдалося зафіксувати HEAD перед мерджем` }

      const needsPublish = selection.mode === 'candidate'
      let validationDirectory = plan.root
      let validatedCommit = baselineCommit
      if (needsPublish) {
        if (!(await pathExists(path.join(worktree, '.git')))) {
          return { ok: false, kind: 'repository', reason: `${repo}: немає worktree для безпечної перевірки ${branch}` }
        }

        try {
          await this.assertLease()
          // Codex мав write-доступ до task worktree, включно з ignored
          // node_modules. Перед security gate не довіряємо marker/cache агента:
          // відтворюємо tooling із mainline заново приватною копією.
          await materializeInstalledDependencies(plan.root, worktree, { forceRefresh: true })
          await this.assertLease()
        } catch (error) {
          return { ok: false, kind: 'repository', reason: `${repo}: ${error.message}` }
        }

        // Спершу вливаємо актуальний mainline у task-worktree та перевіряємо
        // кандидата там. Mainline не змінюється до зелених тестів, тому crash
        // або рестарт release-worker не може лишити його на червоному мерджі.
        const mergeMainline = await this.runMutation('git', ['-C', worktree, 'merge', '--no-edit', plan.branch], {})
        if (mergeMainline.code !== 0) {
          await this.runMutation('git', ['-C', worktree, 'merge', '--abort'], {})
          return { ok: false, kind: 'conflict', reason: `${repo}: конфлікт мерджу з ${branch}` }
        }
        validationDirectory = worktree
        const candidateHead = await this.runProcess('git', ['-C', worktree, 'rev-parse', 'HEAD'], {})
        validatedCommit = /\b[0-9a-f]{40}\b/.exec(candidateHead.output)?.[0]
        if (!validatedCommit) return { ok: false, kind: 'repository', reason: `${repo}: не вдалося визначити candidate commit` }
      }

      const previousValidation = evidence?.repositories?.[repo]
      const selectedChecks = selectRepositoryChecks(plan, selection.files)
      const gateFingerprint = validationGateFingerprint(repo, validatedCommit, selection.files, selectedChecks)
      const validationReusable = previousValidation?.validatedCommit === validatedCommit
        && previousValidation?.validation === 'passed'
        && previousValidation?.gateFingerprint === gateFingerprint
      if (!validationReusable) {
        await this.updateRelease(task, {
          status: 'processing',
          phase: 'validating',
          evidence,
        })
        for (const check of selectedChecks) {
          const result = await this.runReleaseCheck(repo, check, validationDirectory)
          if (result.code !== 0) {
            return {
              ok: false,
              kind: 'validation',
              phase: 'validating',
              reason: `${repo}: перевірка «${check.join(' ')}» впала${result.retried ? ' після одного flake-retry' : ''}; mainline не змінено`,
              evidence,
            }
          }
        }
        evidence = mergeEvidence(evidence, {
          repositories: {
            [repo]: {
              validatedCommit,
              validation: 'passed',
              validatedAt: new Date().toISOString(),
              files: selection.files,
              gateFingerprint,
            },
          },
        })
        await this.updateRelease(task, {
          status: 'processing',
          phase: 'validating',
          evidence,
        })
      }
      prepared.push({ repo, plan, selection, baselineCommit, validatedCommit })
    }

    // Перед першою mainline mutation pin-имо УСІ перевірені refs. Інший run
    // може дописати task-гілку після зеленого gate; merge branch-name тоді
    // непомітно випустив би неперевірений HEAD.
    await this.updateRelease(task, { status: 'processing', phase: 'publishing', evidence })
    await this.assertLease()
    for (const item of prepared) {
      const currentMainline = await this.runProcess('git', ['-C', item.plan.root, 'rev-parse', 'HEAD'], {})
      const currentCommit = /\b[0-9a-f]{40}\b/.exec(currentMainline.output)?.[0]
      if (currentCommit !== item.baselineCommit) {
        return { ok: false, kind: 'transient', phase: 'publishing', reason: `${item.repo}: mainline змінився після validation` }
      }
      if (item.selection.mode === 'candidate') {
        const currentCandidate = await this.runProcess('git', ['-C', item.plan.root, 'rev-parse', branch], {})
        const candidateCommit = /\b[0-9a-f]{40}\b/.exec(currentCandidate.output)?.[0]
        if (candidateCommit !== item.validatedCommit) {
          return {
            ok: false,
            kind: 'transient',
            phase: 'publishing',
            reason: `${item.repo}: task-гілка змінилася після validation; потрібен новий точковий gate`,
          }
        }
      }
    }

    // Усі репозиторії перевірені й pin-нуті. Рухаємо mainline лише на точні
    // SHA, що пройшли gate, а не на mutable branch refs.
    for (const item of prepared) {
      if (item.selection.mode === 'candidate') {
        const publish = await this.runMutation('git', ['-C', item.plan.root, 'merge', '--ff-only', item.validatedCommit], {})
        if (publish.code !== 0) {
          return { ok: false, kind: 'transient', phase: 'publishing', reason: `${item.repo}: не вдалося fast-forward перевіреного ${item.validatedCommit}` }
        }
      }
      const head = await this.runProcess('git', ['-C', item.plan.root, 'rev-parse', 'HEAD'], {})
      const commit = /\b[0-9a-f]{40}\b/.exec(head.output)?.[0]
      if (!commit) return { ok: false, kind: 'repository', phase: 'publishing', reason: `${item.repo}: не вдалося зафіксувати published commit` }
      const expectedCommit = item.selection.mode === 'candidate' ? item.validatedCommit : item.baselineCommit
      if (commit !== expectedCommit) {
        return {
          ok: false,
          kind: 'transient',
          phase: 'publishing',
          reason: `${item.repo}: published SHA не дорівнює перевіреному ${expectedCommit}`,
        }
      }
      item.commit = commit
    }

    for (const item of prepared) {
      await this.assertLease()
      const push = await this.runMutation(
        'git',
        ['-C', item.plan.root, 'push', 'origin', `${item.commit}:refs/heads/${item.plan.branch}`],
        {},
      )
      if (push.code !== 0) {
        return {
          ok: false,
          kind: classifyGitPushFailure(push.output),
          phase: 'publishing',
          reason: `${item.repo}: push не пройшов: ${push.output.slice(-500)}`,
          evidence,
        }
      }
      evidence = mergeEvidence(evidence, {
        repositories: {
          [item.repo]: {
            validatedCommit: item.validatedCommit,
            validation: 'passed',
            commit: item.commit,
            branch: item.plan.branch,
            pushed: true,
            pushedAt: new Date().toISOString(),
          },
        },
      })
      await this.updateRelease(task, { status: 'processing', phase: 'publishing', evidence })
    }

    return {
      ok: true,
      repos: touchedRepos,
      alreadyMerged: prepared.every((item) => item.selection.mode !== 'candidate'),
      repositoryEvidence: evidence.repositories,
    }
  }

  async runReleaseCheck(repo, check, cwd) {
    const run = () => this.runProcess(check[0], check.slice(1), { cwd })
    const first = await run()
    if (first.code === 0) return first
    if (!isRetryableValidation(check, first)) return first
    console.warn(`[release] ${repo}: розпізнано flake у «${check.join(' ')}», повторюю один раз`)
    return { ...await run(), retried: true }
  }

  async updateRelease(task, values) {
    const response = await fetch(`${this.deskBaseUrl}/api/agent-runs/${task.agentRun.id}/release`, {
      method: 'PATCH',
      headers: this.requestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ...values, leaseOwnerId: this.workerId }),
    })
    if (!response.ok) throw new Error(`release-state ${task.id} → ${response.status}`)
    task.agentRun = await response.json()
    if (values.taskStatus) task.status = values.taskStatus
    return task.agentRun
  }

  async cleanupReleasedWorktrees(task) {
    const slug = taskSlug(task.id)
    const branch = branchName(task.id)
    const jobDirectory = path.join(this.worktreesDirectory, slug)
    const errors = []
    let canRemoveJobDirectory = true

    for (const [repo, plan] of Object.entries(this.repoPlan)) {
      const worktree = path.join(jobDirectory, repo)
      if (await pathExists(path.join(worktree, '.git'))) {
        const removed = await this.runMutation('git', ['-C', plan.root, 'worktree', 'remove', '--force', worktree], {})
        if (removed.code !== 0) {
          canRemoveJobDirectory = false
          errors.push(`${repo}: worktree не прибрано`)
        }
      }

      const branchExists = await this.runProcess('git', ['-C', plan.root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {})
      if (branchExists.code === 1) continue
      if (branchExists.code !== 0) {
        errors.push(`${repo}: не вдалося перевірити локальну гілку`)
        continue
      }
      const merged = await this.runProcess('git', ['-C', plan.root, 'merge-base', '--is-ancestor', branch, plan.branch], {})
      if (merged.code !== 0) {
        errors.push(`${repo}: локальна гілка не є частиною ${plan.branch}`)
        continue
      }
      const deleted = await this.runMutation('git', ['-C', plan.root, 'branch', '-D', branch], {})
      if (deleted.code !== 0) errors.push(`${repo}: гілку не прибрано`)
    }

    if (canRemoveJobDirectory) {
      await this.assertLease()
      await rm(jobDirectory, { recursive: true, force: true }).catch(() => {
        errors.push('папку задачі не прибрано')
      })
    }
    return errors
  }

  async recoverReleasedWorktreeCleanup(tasks) {
    for (const task of tasks) {
      if (task.agentRun?.releaseStatus !== 'released') continue
      const jobDirectory = path.join(this.worktreesDirectory, taskSlug(task.id))
      if (!(await pathExists(jobDirectory))) continue
      const errors = await this.cleanupReleasedWorktrees(task)
      if (errors.length > 0) {
        console.error(`[release] ${task.id}: cleanup retry: ${errors.join('; ')}`)
      } else {
        console.log(`[release] ${task.id}: завершено відкладений cleanup worktree`)
      }
    }
  }

  async annotate(task, line) {
    const fresh = await fetch(`${this.deskBaseUrl}/api/tasks`, { headers: this.requestHeaders() })
      .then((response) => response.ok ? response.json() : null)
      .catch(() => null)
    const current = fresh?.find((item) => item.id === task.id)
    const notes = `${(current ?? task).notes ?? ''}\n${line}`.slice(0, 9900)
    await fetch(`${this.deskBaseUrl}/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: this.requestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ notes }),
    }).catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const worker = new ReleaseWorker()
  worker.start()
  const shutdown = async () => {
    await worker.stop()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown())
  process.once('SIGINT', () => void shutdown())
  setInterval(() => {}, 60_000)
}
