import path from 'node:path'
import { createApp } from './app.js'
import { TaskStore } from './store.js'

const port = Number.parseInt(process.env.PORT ?? '4000', 10)
const rootDirectory = process.cwd()
const dataDirectory = process.env.DATA_DIR ?? path.join(rootDirectory, 'data')
const uploadsDirectory = process.env.UPLOAD_DIR ?? path.join(rootDirectory, 'public', 'uploads')
const store = new TaskStore(dataDirectory)
const app = await createApp({ rootDirectory, dataDirectory, uploadsDirectory, store })

const server = app.listen(port, () => {
  console.log(`GBA QA Desk API: http://localhost:${port}`)
})

function shutdown() {
  server.close(() => {
    store.close()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
