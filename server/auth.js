import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

export const sessionCookieName = 'qa_desk_session'
export const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const derivedKey = await scryptAsync(password, salt, 64)
  return `scrypt$${salt.toString('base64url')}$${Buffer.from(derivedKey).toString('base64url')}`
}

export async function verifyPassword(password, storedHash) {
  const [algorithm, encodedSalt, encodedKey] = String(storedHash).split('$')
  if (algorithm !== 'scrypt' || !encodedSalt || !encodedKey) return false

  try {
    const expected = Buffer.from(encodedKey, 'base64url')
    const actual = Buffer.from(await scryptAsync(password, Buffer.from(encodedSalt, 'base64url'), expected.length))
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export function createSessionToken() {
  return randomBytes(32).toString('base64url')
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

export function readCookie(cookieHeader, name) {
  for (const part of String(cookieHeader ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return ''
    }
  }
  return ''
}

export function sessionCookie(token, { secure = false, maxAgeSeconds = sessionLifetimeMs / 1000 } = {}) {
  return [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

export function clearSessionCookie({ secure = false } = {}) {
  return sessionCookie('', { secure, maxAgeSeconds: 0 })
}

export function isMatchingInternalToken(candidate, expected) {
  if (!candidate || !expected) return false
  const actualHash = createHash('sha256').update(candidate).digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  return timingSafeEqual(actualHash, expectedHash)
}
