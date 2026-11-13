import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApp } from '../server/app.js'
import { TaskStore } from '../server/store.js'
import {
  DEFAULT_RUN_STATES,
  RunStateSentinel,
  buildRunTaskDraft,
  parseRunStateSpec,
  readRunOutcome,
  runMarker,
} from '../server/run-sentinel.js'

const SYNC_OK = { run: 'r-ok', mode: 'light', ok: true, failure: null, exit: 0, sessions: true, bases: {}, downstream: {}, preflight_problems: [], finished_at: '2026-11-14T02:41:00+02:00' }
const SYNC_FAILED = {
  run: 'r-1', mode: 'light', ok: false, failure: 'fenix: Failed at Sales', exit: 1, sessions: false,
  bases: { fenix: { ok: false, status: 'Failed', failedStep: 'Sales' }, amg: { ok: true } },
  downstream: { search: false }, preflight_problems: [], finished_at: '2026-11-13T02:55:10+02:00',
}

async function watcherFor(payload, tasks = []) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'run-sentinel-'))
  const file = path.join(directory, 'latest.json')
  const write = async (next) => writeFile(file, typeof next === 'string' ? next : JSON.stringify(next), 'utf8')
  if (payload !== undefined) await write(payload)
  const watcher = new RunStateSentinel({
    dataDirectory: directory,
    sources: [{ file, kind: 'sync', key: 'sync', label: 'Нічна синхронізація 1С', unit: 'gba-sync@light.service' }],
    buildTag: 'test',
  })
  const calls = { created: [], patched: [], lists: 0 }
  watcher.listTasks = async () => { calls.lists += 1; return tasks }
  watcher.createDeskTask = async (draft) => {
    const task = { id: `BUG-${tasks.length + 1}`, ...draft }
    tasks.push(task)
    calls.created.push(task)
    return task
  }
  watcher.patchDeskTask = async (taskId, patch) => {
    const task = tasks.find((item) => item.id === taskId)
    Object.assign(task, patch)
    calls.patched.push({ taskId, patch })
    return task
  }
  return { watcher, write, calls, tasks, directory }
}

test('типові джерела: нічна синхронізація та цикл AI-флоту', () => {
  const sources = parseRunStateSpec(DEFAULT_RUN_STATES)
  assert.deepEqual(sources.map((source) => [source.kind, source.file, source.unit]), [
    ['sync', '/host-state/gba-sync/latest.json', 'gba-sync@light.service'],
    ['fleet', '/host-state/gba-ai-fleet/latest.json', 'gba-ai-fleet-refresh.service'],
  ])
  assert.deepEqual(parseRunStateSpec(''), [])
  assert.deepEqual(parseRunStateSpec('/x/latest.json|невідомий|Щось'), [])
})

test('результат синхронізації читається з ok/failure, циклу флоту — зі status', () => {
  assert.equal(readRunOutcome('sync', SYNC_OK).state, 'ok')
  const failed = readRunOutcome('sync', SYNC_FAILED)
  assert.equal(failed.state, 'failed')
  assert.equal(failed.runId, 'r-1')
  assert.deepEqual(failed.details, ['Режим: light', 'Код виходу: 1', 'База fenix: Failed (крок Sales)', 'Не оновлено: search'])

  assert.equal(readRunOutcome('fleet', { run_id: 'f-1', status: 'complete' }).state, 'ok')
  assert.equal(readRunOutcome('fleet', { run_id: 'f-1', status: 'running' }).state, 'pending')
  assert.equal(readRunOutcome('fleet', { run_id: 'f-1', status: 'partial' }).state, 'pending')
  const fleet = readRunOutcome('fleet', {
    run_id: 'f-2', status: 'failed', cycle_date: '2026-11-13', failure: 'stages not complete: procure',
    failed_stages: ['procure'], failed_services: ['pricing'], failed_at: '2026-11-13T05:40:00+02:00',
    stages: { procure: { status: 'failed', error: 'boom' }, reco: { status: 'complete' } },
  })
  assert.equal(fleet.state, 'failed')
  assert.deepEqual(fleet.details, ['Цикл: 2026-11-13', 'Незавершені етапи: procure', 'Нездорові сервіси: pricing', 'Етап procure: boom'])

  assert.equal(readRunOutcome('sync', { ok: false }), null)
  assert.equal(readRunOutcome('sync', { run: 'r', ok: 'так' }), null)
  assert.equal(readRunOutcome('fleet', {}), null)
  assert.equal(readRunOutcome('sync', null), null)
})

test('чернетка задачі про невдалий запуск: маркер із run id, без AI-запуску', () => {
  const source = parseRunStateSpec(DEFAULT_RUN_STATES)[0]
  const draft = buildRunTaskDraft(source, readRunOutcome('sync', SYNC_FAILED), 'b42', new Date('2026-11-13T01:00:00Z'))
  assert.match(draft.title, /^\[AUTO\] Нічна синхронізація 1С: запуск не вдався — fenix: Failed at Sales$/)
  assert.equal(draft.aiMode, 'off')
  assert.equal(draft.priority, 'high')
  assert.deepEqual(runMarker(draft), { key: 'sync', runId: 'r-1' })
  assert.match(draft.notes, /journalctl -u gba-sync@light\.service/)
  assert.match(draft.notes, /База fenix: Failed \(крок Sales\)/)
  assert.ok(draft.notes.length <= 9800)
})

test('невдалий запуск заводить одну задачу, повторне опитування її не дублює і не чіпає desk', async () => {
  const { watcher, calls } = await watcherFor(SYNC_FAILED)
  assert.deepEqual(await watcher.pollOnce(), ['created'])
  assert.deepEqual(await watcher.pollOnce(), ['unchanged'])
  assert.deepEqual(await watcher.pollOnce(), ['unchanged'])
  assert.equal(calls.created.length, 1)
  assert.equal(calls.patched.length, 0)
  assert.equal(calls.lists, 1)
})

test('наступний невдалий запуск оновлює ту саму задачу, а не заводить другу', async () => {
  const { watcher, write, calls, tasks } = await watcherFor(SYNC_FAILED)
  await watcher.pollOnce()
  await write({ ...SYNC_FAILED, run: 'r-2', failure: 'pre-flight: credential is unusable', exit: 2 })
  assert.deepEqual(await watcher.pollOnce(), ['updated'])
  assert.equal(tasks.length, 1)
  assert.equal(calls.created.length, 1)
  assert.deepEqual(runMarker(tasks[0]), { key: 'sync', runId: 'r-2' })
  assert.match(tasks[0].title, /credential is unusable/)
  assert.match(tasks[0].notes, /Невдалих запусків поспіль: 2/)
  assert.equal(Object.hasOwn(calls.patched[0].patch, 'status'), false)

  await write({ ...SYNC_FAILED, run: 'r-3' })
  await watcher.pollOnce()
  assert.match(tasks[0].notes, /Невдалих запусків поспіль: 3/)
  assert.equal(tasks.length, 1)
})

test('успішний запуск закриває відкриту задачу і зберігає маркер', async () => {
  const { watcher, write, calls, tasks } = await watcherFor(SYNC_FAILED)
  await watcher.pollOnce()
  await write(SYNC_OK)
  assert.deepEqual(await watcher.pollOnce(), ['closed'])
  assert.equal(tasks[0].status, 'done')
  assert.match(tasks[0].notes, /Автоматично закрито .*запуск r-ok успішний/)
  assert.deepEqual(runMarker(tasks[0]), { key: 'sync', runId: 'r-1' })
  assert.deepEqual(await watcher.pollOnce(), ['unchanged'])
  assert.equal(calls.patched.length, 1)

  await write({ ...SYNC_FAILED, run: 'r-9' })
  assert.deepEqual(await watcher.pollOnce(), ['created'])
  assert.equal(tasks.length, 2)
})

test('успішний запуск без відкритої задачі нічого не створює', async () => {
  const { watcher, calls } = await watcherFor(SYNC_OK)
  assert.deepEqual(await watcher.pollOnce(), ['ok'])
  assert.equal(calls.created.length + calls.patched.length, 0)
})

test('задачу, закриту людиною, той самий невдалий запуск не відкриває знову — навіть без збереженого стану', async () => {
  const { watcher, calls, tasks } = await watcherFor(SYNC_FAILED)
  await watcher.pollOnce()
  tasks[0].status = 'done'
  assert.deepEqual(await watcher.pollOnce(), ['unchanged'])

  watcher.state = { runs: {} }
  assert.deepEqual(await watcher.pollOnce(), ['unchanged'])
  assert.equal(calls.created.length, 1)
})

test('після рестарту вартового відкрита задача того самого запуску не дублюється', async () => {
  const { watcher, calls, directory } = await watcherFor(SYNC_FAILED)
  await watcher.pollOnce()
  const saved = JSON.parse(await readFile(path.join(directory, 'run-sentinel-state.json'), 'utf8'))
  assert.equal(saved.runs.sync.runId, 'r-1')
  assert.equal(saved.runs.sync.taskId, 'BUG-1')

  watcher.state = { runs: {} }
  assert.deepEqual(await watcher.pollOnce(), ['unchanged'])
  assert.equal(calls.created.length, 1)
})

test('цикл флоту в процесі не закриває і не оновлює задачу', async () => {
  const tasks = []
  const directory = await mkdtemp(path.join(os.tmpdir(), 'run-sentinel-'))
  const file = path.join(directory, 'latest.json')
  const watcher = new RunStateSentinel({
    dataDirectory: directory,
    sources: [{ file, kind: 'fleet', key: 'fleet', label: 'Щоденний цикл AI-флоту', unit: '' }],
  })
  watcher.listTasks = async () => tasks
  watcher.createDeskTask = async (draft) => { const task = { id: 'BUG-7', ...draft }; tasks.push(task); return task }
  watcher.patchDeskTask = async (taskId, patch) => Object.assign(tasks.find((task) => task.id === taskId), patch)

  await writeFile(file, JSON.stringify({ run_id: 'f-1', status: 'failed', failure: 'stages not complete: nba' }), 'utf8')
  assert.deepEqual(await watcher.pollOnce(), ['created'])
  await writeFile(file, JSON.stringify({ run_id: 'f-2', status: 'running' }), 'utf8')
  assert.deepEqual(await watcher.pollOnce(), ['pending'])
  assert.equal(tasks[0].status, 'new')
  await writeFile(file, JSON.stringify({ run_id: 'f-2', status: 'complete' }), 'utf8')
  assert.deepEqual(await watcher.pollOnce(), ['closed'])
  assert.equal(tasks[0].status, 'done')
})

test('відсутній або зіпсований файл стану не заводить задач і не валить опитування', async () => {
  const { watcher, write, calls } = await watcherFor(undefined)
  assert.deepEqual(await watcher.pollOnce(), ['unreadable'])
  await write('{"run": "r-1", "ok"')
  assert.deepEqual(await watcher.pollOnce(), ['unreadable'])
  assert.equal(calls.lists, 0)
})

test('збій desk-API не втрачає невдалий запуск: наступне опитування заводить задачу', async () => {
  const { watcher, calls } = await watcherFor(SYNC_FAILED)
  const listTasks = watcher.listTasks
  watcher.listTasks = async () => { throw new Error('desk /api/tasks → 502') }
  assert.deepEqual(await watcher.pollOnce(), ['error'])
  watcher.listTasks = listTasks
  assert.deepEqual(await watcher.pollOnce(), ['created'])
  assert.equal(calls.created.length, 1)
})

test('наскрізно через справжній desk-API: створення, оновлення, автозакриття — одна задача без AI-запуску', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'run-sentinel-desk-'))
  const store = new TaskStore(path.join(root, 'data'))
  const app = await createApp({
    rootDirectory: root,
    dataDirectory: path.join(root, 'data'),
    uploadsDirectory: path.join(root, 'uploads'),
    store,
    authRequired: true,
    internalApiToken: 'test-internal-token',
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    const file = path.join(root, 'latest.json')
    const watcher = new RunStateSentinel({
      deskBaseUrl: `http://127.0.0.1:${server.address().port}`,
      dataDirectory: path.join(root, 'sentinel'),
      sources: [{ file, kind: 'sync', key: 'sync', label: 'Нічна синхронізація 1С', unit: 'gba-sync@light.service' }],
      internalApiToken: 'test-internal-token',
    })
    await watcher.start()
    const before = (await watcher.listTasks()).length

    await writeFile(file, JSON.stringify(SYNC_FAILED), 'utf8')
    assert.deepEqual(await watcher.pollOnce(), ['created'])
    await writeFile(file, JSON.stringify({ ...SYNC_FAILED, run: 'r-2' }), 'utf8')
    assert.deepEqual(await watcher.pollOnce(), ['updated'])

    let tasks = await watcher.listTasks()
    assert.equal(tasks.length, before + 1)
    const task = tasks.find((item) => runMarker(item)?.key === 'sync')
    assert.equal(task.status, 'new')
    assert.equal(task.aiMode, 'off')
    assert.deepEqual(runMarker(task), { key: 'sync', runId: 'r-2' })
    assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE task_id = ?').get(task.id).n, 0)

    await writeFile(file, JSON.stringify(SYNC_OK), 'utf8')
    assert.deepEqual(await watcher.pollOnce(), ['closed'])
    tasks = await watcher.listTasks()
    assert.equal(tasks.length, before + 1)
    assert.equal(tasks.find((item) => item.id === task.id).status, 'done')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
