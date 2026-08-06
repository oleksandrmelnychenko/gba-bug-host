import path from 'node:path'
import { CodexWorker } from './codex-worker.js'
import { TaskStore } from './store.js'

const rootDirectory = process.cwd()
const dataDirectory = process.env.DATA_DIR ?? path.join(rootDirectory, 'data')
const uploadsDirectory = process.env.UPLOAD_DIR ?? path.join(rootDirectory, 'public', 'uploads')
const store = new TaskStore(dataDirectory)

await store.ensureReady()

const worker = new CodexWorker({ store, rootDirectory, dataDirectory, uploadsDirectory })
worker.start()
console.log(`Codex worker запущено. Цільовий репозиторій: ${worker.targetRepository}`)

function shutdown() {
  worker.stop()
  store.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
