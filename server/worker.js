import path from 'node:path'
import { CodexWorker, prewarmDotnetFirstRun } from './codex-worker.js'
import { TaskStore } from './store.js'

const rootDirectory = process.cwd()
const dataDirectory = process.env.DATA_DIR ?? path.join(rootDirectory, 'data')
const uploadsDirectory = process.env.UPLOAD_DIR ?? path.join(rootDirectory, 'public', 'uploads')
const store = new TaskStore(dataDirectory)

await store.ensureReady()

if (process.env.CODEX_DOTNET_PREWARM !== 'false') {
  const prewarm = await prewarmDotnetFirstRun()
  console.log(prewarm.ok ? 'Codex worker: first-run стан dotnet/NuGet підготовлено.' : `Codex worker: ${prewarm.reason}`)
}

const worker = new CodexWorker({ store, rootDirectory, dataDirectory, uploadsDirectory })
worker.start()
console.log(`Codex worker: паралельних агентів ${worker.concurrency}.`)
for (const [project, stack] of Object.entries(worker.projectStacks)) {
  console.log(`Codex worker запущено. Проєкт ${project}: ${stack.length ? stack.map((repository) => repository.repositoryPath).join(', ') : 'не налаштовано'}`)
}

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await worker.stop()
  store.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
