import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { hashPassword } from './auth.js'
import { TaskStore } from './store.js'

const [email, displayName, password] = process.argv.slice(2)
if (!email || !displayName || !password) {
  console.error('Usage: node server/provision-users.js <email> <display-name> <password>')
  process.exit(2)
}
if (password.length < 12) {
  console.error('Password must contain at least 12 characters.')
  process.exit(2)
}

const dataDirectory = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
const store = new TaskStore(dataDirectory)
try {
  await store.ensureReady()
  const existing = store.findUserByEmail(email)
  const user = store.upsertUser({
    id: existing?.id ?? randomUUID(),
    email,
    displayName,
    passwordHash: await hashPassword(password),
  })
  if (!existing) store.markAllCommentsRead(user.id)
  store.deleteSessionsForUser(user.id)
  console.log(`Provisioned ${user.email} (${user.displayName}). Existing sessions revoked.`)
} finally {
  store.close()
}
