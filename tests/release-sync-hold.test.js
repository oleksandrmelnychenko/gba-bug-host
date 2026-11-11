import assert from 'node:assert/strict'
import test from 'node:test'
import { ReleaseWorker } from '../server/release-worker.js'

function probeWorker(runProcess) {
  const worker = Object.create(ReleaseWorker.prototype)
  worker.runProcess = runProcess
  return worker
}

test('a running DEV data sync is detected from the database probe', async () => {
  const calls = []
  const worker = probeWorker(async (command, args) => {
    calls.push([command, args[0]])
    return { code: 0, output: 'SYNC_RUNNING\n' }
  })
  assert.equal(await worker.devDataSyncRunning(), true)
  assert.deepEqual(calls, [['docker', 'exec']])
})

test('an idle sync, a failed probe and a thrown probe do not hold a release', async () => {
  assert.equal(await probeWorker(async () => ({ code: 0, output: 'SYNC_IDLE\n' })).devDataSyncRunning(), false)
  assert.equal(await probeWorker(async () => ({ code: 1, output: 'SYNC_RUNNING' })).devDataSyncRunning(), false)
  assert.equal(await probeWorker(async () => { throw new Error('docker unavailable') }).devDataSyncRunning(), false)
})
