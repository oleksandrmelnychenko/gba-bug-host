import path from 'node:path'
import { TaskStore } from './store.js'

const dataDirectory = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
const store = new TaskStore(dataDirectory)

try {
  await store.ensureReady()
  console.log(`SQLite migrations applied: ${store.databasePath}`)
} finally {
  store.close()
}
