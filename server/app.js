import { randomUUID } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import multer from 'multer'
import {
  clearSessionCookie,
  createSessionToken,
  hashSessionToken,
  isMatchingInternalToken,
  readCookie,
  sessionCookie,
  sessionCookieName,
  sessionLifetimeMs,
  verifyPassword,
} from './auth.js'
import { BuildNumberSource } from './build-source.js'
import { TaskStore } from './store.js'
import { TopologyService } from './topology.js'
import { TranscriptionError, transcribeAudioWithShell } from './transcription.js'

const allowedStatuses = new Set(['new', 'in_progress', 'ready_for_retest', 'review_again', 'done', 'blocked'])
const allowedPriorities = new Set(['low', 'medium', 'high', 'critical'])
const allowedProjects = new Set(['console', 'ecommerce'])
const allowedReleaseStatuses = new Set(['pending', 'processing', 'retrying', 'released', 'blocked'])
const allowedReleaseTaskStatuses = allowedStatuses
const allowedReleasePhases = new Set([
  '',
  'queued',
  'preflight',
  'validating',
  'publishing',
  'migrating',
  'deploying',
  'verifying',
  'released',
  'failed',
])
const allowedMediaTypes = new Map([
  ['image/jpeg', { extension: '.jpg', kind: 'image', maxSize: 10 * 1024 * 1024 }],
  ['image/png', { extension: '.png', kind: 'image', maxSize: 10 * 1024 * 1024 }],
  ['image/webp', { extension: '.webp', kind: 'image', maxSize: 10 * 1024 * 1024 }],
  ['image/gif', { extension: '.gif', kind: 'image', maxSize: 10 * 1024 * 1024 }],
  ['image/avif', { extension: '.avif', kind: 'image', maxSize: 10 * 1024 * 1024 }],
  ['video/mp4', { extension: '.mp4', kind: 'video', maxSize: 200 * 1024 * 1024 }],
  ['video/webm', { extension: '.webm', kind: 'video', maxSize: 200 * 1024 * 1024 }],
  ['video/quicktime', { extension: '.mov', kind: 'video', maxSize: 200 * 1024 * 1024 }],
])
const allowedVoiceTypes = new Map([
  ['audio/webm', '.webm'],
  ['video/webm', '.webm'],
  ['audio/mp4', '.m4a'],
  ['video/mp4', '.mp4'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/mpga', '.mpga'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
])

function createFileName(file) {
  return `${Date.now()}-${randomUUID()}${allowedMediaTypes.get(file.mimetype).extension}`
}

function cleanText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function publicAgentRun(run) {
  if (!run) return run
  const { contextSnapshot: _contextSnapshot, codexSessionId: _codexSessionId, ...publicRun } = run
  return publicRun
}

function normalizeSiteUrl(value, errors) {
  const rawUrl = cleanText(value)
  if (!rawUrl) return ''
  if (rawUrl.length > 2048) {
    errors.push('URL має бути коротшим за 2048 символів.')
    return rawUrl
  }

  try {
    const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`
    const parsedUrl = new URL(normalizedUrl)
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Unsupported protocol')
    return parsedUrl.toString()
  } catch {
    errors.push('Вкажіть коректний URL сайту.')
    return rawUrl
  }
}

function serializeAttachment(file) {
  return {
    id: randomUUID(),
    name: file.originalname,
    url: `/uploads/${file.filename}`,
    type: file.mimetype,
    size: file.size,
    kind: allowedMediaTypes.get(file.mimetype).kind,
  }
}

function getMediaValidationError(files = []) {
  for (const file of files) {
    const rules = allowedMediaTypes.get(file.mimetype)
    if (!rules) return 'Підтримуються зображення JPG, PNG, WEBP, GIF, AVIF та відео MP4, WEBM або MOV.'
    if (file.size > rules.maxSize) {
      return rules.kind === 'video'
        ? 'Відео завелике. Максимальний розмір одного файлу — 200 МБ.'
        : 'Зображення завелике. Максимальний розмір одного файлу — 10 МБ.'
    }
  }
  return null
}

function validateTaskInput(body, { partial = false } = {}) {
  const errors = []
  const title = cleanText(body.title)
  const description = cleanText(body.description)
  const siteUrl = normalizeSiteUrl(body.siteUrl, errors)
  const notes = cleanText(body.notes)
  const staffComments = cleanText(body.staffComments)
  const reviewComment = cleanText(body.reviewComment)
  const area = cleanText(body.area)
  const project = cleanText(body.project)
  const status = cleanText(body.status)
  const priority = cleanText(body.priority)
  const assignee = cleanText(body.assignee)

  if ((!partial || Object.hasOwn(body, 'title')) && title.length < 3) {
    errors.push('Назва задачі має містити щонайменше 3 символи.')
  }
  if (title.length > 140) errors.push('Назва задачі має бути коротшою за 140 символів.')
  if (description.length > 3000) errors.push('Опис має бути коротшим за 3000 символів.')
  if (notes.length > 10000) errors.push('Нотатки мають бути коротшими за 10000 символів.')
  if (staffComments.length > 5000) errors.push('Коментарі співробітників мають бути коротшими за 5000 символів.')
  if (reviewComment.length > 5000) errors.push('Коментар для AI має бути коротшим за 5000 символів.')
  if (area.length > 80) errors.push('Назва розділу має бути коротшою за 80 символів.')
  if (assignee.length > 80) errors.push('Ім’я виконавця має бути коротшим за 80 символів.')
  if (status && !allowedStatuses.has(status)) errors.push('Невідомий статус задачі.')
  if (priority && !allowedPriorities.has(priority)) errors.push('Невідомий пріоритет задачі.')
  if (project && !allowedProjects.has(project)) errors.push('Невідомий проєкт задачі.')

  return {
    errors,
    values: { title, description, siteUrl, notes, staffComments, reviewComment, area, project, status, priority, assignee },
  }
}

function validateCommentInput(body, authenticatedUser = null) {
  const errors = []
  const author = authenticatedUser?.displayName ?? cleanText(body?.author)
  const commentBody = cleanText(body?.body)
  const parentId = cleanText(body?.parentId) || null

  if (author.length < 2) errors.push('Вкажіть ім’я співробітника.')
  if (author.length > 80) errors.push('Ім’я співробітника має бути коротшим за 80 символів.')
  if (!commentBody) errors.push('Напишіть текст коментаря.')
  if (commentBody.length > 5000) errors.push('Коментар має бути коротшим за 5000 символів.')
  if (parentId && parentId.length > 100) errors.push('Некоректний коментар для відповіді.')

  return {
    errors,
    values: {
      author,
      authorUserId: authenticatedUser?.internal ? null : authenticatedUser?.id ?? null,
      body: commentBody,
      parentId,
    },
  }
}

async function removeUploadedFiles(files) {
  await Promise.all(
    (files ?? []).map((file) => unlink(file.path).catch(() => undefined)),
  )
}

export async function createApp(options = {}) {
  const rootDirectory = options.rootDirectory ?? process.cwd()
  const dataDirectory = options.dataDirectory ?? process.env.DATA_DIR ?? path.join(rootDirectory, 'data')
  const uploadsDirectory = options.uploadsDirectory ?? process.env.UPLOAD_DIR ?? path.join(rootDirectory, 'public', 'uploads')
  const buildNumber = options.buildNumber ?? process.env.APP_BUILD_NUMBER ?? '0.1.0-local'
  const buildSource = options.buildSource ?? new BuildNumberSource({ fallback: buildNumber })
  const configuredAgentRunStaleMs = options.agentRunStaleMs
    ?? Number.parseInt(process.env.CODEX_RUN_STALE_MS ?? '30000', 10)
  const agentRunStaleMs = Number.isInteger(configuredAgentRunStaleMs) && configuredAgentRunStaleMs > 0
    ? configuredAgentRunStaleMs
    : 30_000
  const currentBuildNumber = () => buildSource.current()
  const store = options.store ?? new TaskStore(dataDirectory)
  const topology = options.topology ?? new TopologyService()
  topology.persist = (heartbeat) => store.saveSystemState('systemd-heartbeat', heartbeat)
  const transcribeAudio = options.transcribeAudio ?? transcribeAudioWithShell
  const authRequired = options.authRequired ?? process.env.QA_DESK_AUTH_REQUIRED !== 'false'
  const internalApiToken = options.internalApiToken ?? process.env.QA_DESK_INTERNAL_API_TOKEN ?? ''
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === 'production'
  const loginAttempts = new Map()

  await mkdir(uploadsDirectory, { recursive: true })
  await store.ensureReady()
  store.ensureBuild(await currentBuildNumber())
  topology.restoreHeartbeat(store.readSystemState('systemd-heartbeat'))

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadsDirectory,
      filename: (_request, file, callback) => callback(null, createFileName(file)),
    }),
    limits: { fileSize: 200 * 1024 * 1024, files: 6 },
    fileFilter: (_request, file, callback) => {
      if (!allowedMediaTypes.has(file.mimetype)) {
        callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'attachments'))
        return
      }
      callback(null, true)
    },
  })
  const voiceUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
    fileFilter: (_request, file, callback) => {
      if (!allowedVoiceTypes.has(file.mimetype)) {
        callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'audio'))
        return
      }
      callback(null, true)
    },
  })

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  const authenticateRequest = (request, response, next) => {
    const publicRequest = request.baseUrl === '/api' && (
      request.path === '/health'
      || request.path === '/auth/login'
      || (request.path === '/builds/current' && request.method === 'GET')
    )
    if (publicRequest) {
      next()
      return
    }
    const authorization = request.get('authorization') ?? ''
    const internalToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (isMatchingInternalToken(internalToken, internalApiToken)) {
      request.user = { id: null, email: 'system@qa-desk.local', displayName: 'Система', internal: true }
      next()
      return
    }
    if (!authRequired) {
      request.user = null
      next()
      return
    }

    const token = readCookie(request.get('cookie'), sessionCookieName)
    const user = token ? store.findSession(hashSessionToken(token)) : null
    if (!user) {
      response.status(401).json({ message: 'Увійдіть у свій акаунт.' })
      return
    }
    request.user = { ...user, internal: false }
    next()
  }
  app.use('/api', authenticateRequest)
  app.use('/uploads', authenticateRequest, express.static(uploadsDirectory, { maxAge: '7d', immutable: true }))

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true })
  })

  app.post('/api/auth/login', async (request, response, next) => {
    try {
      const email = cleanText(request.body?.email).toLowerCase()
      const password = typeof request.body?.password === 'string' ? request.body.password : ''
      const attemptKey = `${request.ip}:${email}`
      const now = Date.now()
      const attempts = loginAttempts.get(attemptKey)
      if (attempts?.resetAt > now && attempts.count >= 5) {
        response.status(429).json({ message: 'Забагато невдалих спроб. Спробуйте через 15 хвилин.' })
        return
      }
      if (!email || email.length > 254 || !password || password.length > 256) {
        response.status(401).json({ message: 'Неправильний email або пароль.' })
        return
      }

      const user = store.findUserByEmail(email)
      if (!user?.active || !await verifyPassword(password, user.passwordHash)) {
        const current = attempts?.resetAt > now ? attempts : { count: 0, resetAt: now + 15 * 60 * 1000 }
        loginAttempts.set(attemptKey, { ...current, count: current.count + 1 })
        response.status(401).json({ message: 'Неправильний email або пароль.' })
        return
      }

      loginAttempts.delete(attemptKey)
      const token = createSessionToken()
      const expiresAt = new Date(now + sessionLifetimeMs).toISOString()
      store.createSession(hashSessionToken(token), user.id, expiresAt)
      response.setHeader('Set-Cookie', sessionCookie(token, { secure: secureCookies }))
      response.json({ id: user.id, email: user.email, displayName: user.displayName })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/auth/me', (request, response) => {
    response.json({
      id: request.user.id,
      email: request.user.email,
      displayName: request.user.displayName,
    })
  })

  app.post('/api/auth/logout', (request, response) => {
    const token = readCookie(request.get('cookie'), sessionCookieName)
    if (token) store.deleteSession(hashSessionToken(token))
    response.setHeader('Set-Cookie', clearSessionCookie({ secure: secureCookies }))
    response.status(204).end()
  })

  app.get('/api/topology', async (_request, response, next) => {
    try {
      response.json(await topology.collect())
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/system/units', (_request, response) => {
    response.json({ units: topology.units() })
  })

  app.post('/api/system/heartbeat', (request, response) => {
    const units = request.body?.units
    if (!units || typeof units !== 'object' || Array.isArray(units)) {
      response.status(422).json({ errors: ['Очікується об’єкт units із станами systemd-юнітів.'] })
      return
    }
    response.json(topology.recordHeartbeat({ units, host: cleanText(request.body?.host) }))
  })

  const requireInternalWorker = (request, response) => {
    if (request.user?.internal) return true
    response.status(403).json({ message: 'Ця операція доступна лише внутрішньому worker.' })
    return false
  }

  app.post('/api/system/worker-leases/:name/acquire', (request, response) => {
    if (!requireInternalWorker(request, response)) return
    const name = cleanText(request.params.name).slice(0, 100)
    const ownerId = cleanText(request.body?.ownerId).slice(0, 100)
    const ttlMs = Number(request.body?.ttlMs)
    if (!name || !ownerId || !Number.isInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 10 * 60_000) {
      response.status(422).json({ message: 'Потрібні name, ownerId і ttlMs від 5000 до 600000.' })
      return
    }
    const staleBefore = new Date(Date.now() - ttlMs).toISOString()
    const acquired = store.acquireWorkerLease(name, ownerId, staleBefore)
    response.status(acquired ? 200 : 409).json({ acquired })
  })

  app.post('/api/system/worker-leases/:name/heartbeat', (request, response) => {
    if (!requireInternalWorker(request, response)) return
    const ownerId = cleanText(request.body?.ownerId).slice(0, 100)
    if (!ownerId) {
      response.status(422).json({ message: 'Потрібен ownerId.' })
      return
    }
    const alive = store.heartbeatWorkerLease(cleanText(request.params.name).slice(0, 100), ownerId)
    response.status(alive ? 200 : 409).json({ alive })
  })

  app.delete('/api/system/worker-leases/:name', (request, response) => {
    if (!requireInternalWorker(request, response)) return
    const ownerId = cleanText(request.body?.ownerId).slice(0, 100)
    const released = ownerId
      ? store.releaseWorkerLease(cleanText(request.params.name).slice(0, 100), ownerId)
      : false
    response.status(released ? 200 : 409).json({ released })
  })

  app.get('/api/tasks', async (_request, response, next) => {
    try {
      response.json(await store.all())
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/comments/unread', (request, response) => {
    response.json(request.user?.id
      ? store.unreadCommentsForUser(request.user.id)
      : { total: 0, comments: [] })
  })

  app.get('/api/builds/current', async (_request, response, next) => {
    try {
      response.json(await store.ensureBuild(await currentBuildNumber()))
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/transcriptions', voiceUpload.single('audio'), async (request, response, next) => {
    try {
      if (!request.file?.size) {
        response.status(400).json({ message: 'Спочатку запишіть голосове повідомлення.' })
        return
      }

      response.json({ text: await transcribeAudio(request.file) })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/tasks', upload.array('attachments', 6), async (request, response, next) => {
    try {
      const { errors, values } = validateTaskInput(request.body)
      const mediaError = getMediaValidationError(request.files)
      if (mediaError) errors.push(mediaError)
      if (errors.length > 0) {
        await removeUploadedFiles(request.files)
        response.status(400).json({ message: errors[0], errors })
        return
      }

      const task = await store.create({
        title: values.title,
        description: values.description,
        siteUrl: values.siteUrl,
        notes: values.notes,
        staffComments: values.staffComments,
        staffCommentAuthor: request.user?.displayName ?? 'Команда',
        staffCommentAuthorUserId: request.user?.internal ? null : request.user?.id ?? null,
        reviewComment: values.reviewComment,
        area: values.area || 'Загальне',
        project: values.project || 'console',
        status: values.status || 'new',
        priority: values.priority || 'medium',
        assignee: values.assignee || 'Не призначено',
      }, request.files.map(serializeAttachment))

      if (['ready_for_retest', 'done'].includes(task.status)) {
        store.markTaskProcessed(task.id, 'manual')
      }
      store.enqueueAgentRun(randomUUID(), task.id, 'manual')

      response.status(201).json(await store.find(task.id))
    } catch (error) {
      await removeUploadedFiles(request.files)
      next(error)
    }
  })

  app.patch('/api/tasks/:id', async (request, response, next) => {
    try {
      const { errors, values } = validateTaskInput(request.body, { partial: true })
      if (errors.length > 0) {
        response.status(400).json({ message: errors[0], errors })
        return
      }
      const existingTask = await store.find(request.params.id)
      if (!existingTask) {
        response.status(404).json({ message: 'Задачу не знайдено.' })
        return
      }
      const startsReviewRun = values.status === 'review_again' && existingTask.status !== 'review_again'
      if (startsReviewRun && store.hasActiveRelease(request.params.id)) {
        response.status(409).json({ message: 'Задача вже проходить release. Дочекайтеся ретесту або помилки release.' })
        return
      }
      if (startsReviewRun && (!Object.hasOwn(request.body, 'reviewComment') || values.reviewComment.length < 3)) {
        response.status(400).json({ message: 'Опишіть для AI, що саме залишилося невиправленим.' })
        return
      }

      const patch = {}
      for (const key of ['title', 'description', 'siteUrl', 'notes', 'staffComments', 'reviewComment', 'area', 'project', 'status', 'priority', 'assignee']) {
        if (Object.hasOwn(request.body, key)) patch[key] = values[key]
      }
      if (Object.hasOwn(patch, 'project') && !patch.project) delete patch.project
      await store.patch(request.params.id, patch)

      if (['ready_for_retest', 'done'].includes(values.status) && existingTask.status !== values.status) {
        store.markTaskProcessed(request.params.id, 'manual')
      }

      if (startsReviewRun) {
        store.enqueueAgentRun(randomUUID(), request.params.id, 'review_again')
      }
      response.json(await store.find(request.params.id))
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/tasks/:id/comments', async (request, response, next) => {
    try {
      if (!await store.find(request.params.id)) {
        response.status(404).json({ message: 'Задачу не знайдено.' })
        return
      }
      response.json(await store.commentsForTask(request.params.id))
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/tasks/:id/comments', async (request, response, next) => {
    try {
      const { errors, values } = validateCommentInput(request.body, request.user)
      if (errors.length > 0) {
        response.status(400).json({ message: errors[0], errors })
        return
      }

      const result = await store.addTaskComment(randomUUID(), request.params.id, values)
      if (result.status === 'task_not_found') {
        response.status(404).json({ message: 'Задачу не знайдено.' })
        return
      }
      if (result.status === 'parent_not_found') {
        response.status(400).json({ message: 'Коментар, на який ви відповідаєте, не знайдено в цій задачі.' })
        return
      }
      response.status(201).json(result.comment)
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/tasks/:id/comments/read', async (request, response, next) => {
    try {
      if (!await store.find(request.params.id)) {
        response.status(404).json({ message: 'Задачу не знайдено.' })
        return
      }
      response.json(request.user?.id
        ? store.markTaskCommentsRead(request.user.id, request.params.id)
        : { total: 0, comments: [] })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/tasks/:id/review-again', upload.array('attachments', 6), async (request, response, next) => {
    try {
      const { errors, values } = validateTaskInput(request.body, { partial: true })
      const mediaError = getMediaValidationError(request.files)
      if (mediaError) errors.push(mediaError)
      if (!Object.hasOwn(request.body, 'reviewComment') || values.reviewComment.length < 3) {
        errors.push('Опишіть для AI, що саме залишилося невиправленим.')
      }
      if (errors.length > 0) {
        await removeUploadedFiles(request.files)
        response.status(400).json({ message: errors[0], errors })
        return
      }

      const patch = { reviewComment: values.reviewComment }
      for (const key of ['title', 'description', 'siteUrl', 'notes', 'staffComments', 'area', 'project', 'priority', 'assignee']) {
        if (Object.hasOwn(request.body, key)) patch[key] = values[key]
      }
      if (Object.hasOwn(patch, 'project') && !patch.project) delete patch.project

      const result = store.reviewAgain(
        randomUUID(),
        request.params.id,
        patch,
        request.files.map(serializeAttachment),
      )
      if (result.status === 'task_not_found') {
        await removeUploadedFiles(request.files)
        response.status(404).json({ message: 'Задачу не знайдено.' })
        return
      }
      if (result.status === 'release_active') {
        await removeUploadedFiles(request.files)
        response.status(409).json({ message: 'Задача вже проходить release. Дочекайтеся ретесту або помилки release.' })
        return
      }
      if (result.status === 'active' || result.status === 'already_reviewing') {
        await removeUploadedFiles(request.files)
        response.status(409).json({ message: 'Для цієї задачі AI уже запущено або стоїть у черзі.' })
        return
      }

      response.status(202).json(result.task)
    } catch (error) {
      await removeUploadedFiles(request.files)
      next(error)
    }
  })

  app.get('/api/tasks/:id/agent-runs', async (request, response, next) => {
    try {
      if (!await store.find(request.params.id)) {
        response.status(404).json({ message: 'Задачу не знайдено.' })
        return
      }
      response.json(await store.agentRunsForTask(request.params.id))
    } catch (error) {
      next(error)
    }
  })

  app.patch('/api/agent-runs/:id/release', (request, response, next) => {
    try {
      if (!requireInternalWorker(request, response)) return
      const leaseOwnerId = cleanText(request.body?.leaseOwnerId).slice(0, 100)
      if (!store.ownsWorkerLease('release-worker', leaseOwnerId)) {
        response.status(409).json({ message: 'Release-worker не володіє активним singleton lease.' })
        return
      }
      const existingRun = store.findAgentRun(request.params.id)
      if (!existingRun) {
        response.status(404).json({ message: 'AI-запуск не знайдено.' })
        return
      }
      const values = {}
      if (Object.hasOwn(request.body, 'status')) {
        const status = cleanText(request.body.status)
        if (!allowedReleaseStatuses.has(status)) {
          response.status(422).json({ message: 'Невідомий release-статус.' })
          return
        }
        values.status = status
      }
      if (Object.hasOwn(request.body, 'attempts')) {
        const attempts = Number(request.body.attempts)
        if (!Number.isInteger(attempts) || attempts < 0) {
          response.status(422).json({ message: 'Кількість release-спроб має бути невід’ємним цілим числом.' })
          return
        }
        values.attempts = attempts
      }
      if (Object.hasOwn(request.body, 'repositories')) {
        if (!Array.isArray(request.body.repositories) || request.body.repositories.some((item) => typeof item !== 'string')) {
          response.status(422).json({ message: 'repositories має бути масивом рядків.' })
          return
        }
        values.repositories = request.body.repositories
      }
      if (Object.hasOwn(request.body, 'error')) values.error = cleanText(request.body.error).slice(0, 3000)
      if (Object.hasOwn(request.body, 'phase')) {
        const phase = cleanText(request.body.phase)
        if (!allowedReleasePhases.has(phase)) {
          response.status(422).json({ message: 'Невідома фаза release.' })
          return
        }
        values.phase = phase
      }
      if (Object.hasOwn(request.body, 'evidence')) {
        const evidence = request.body.evidence
        if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
          response.status(422).json({ message: 'evidence має бути JSON-об’єктом.' })
          return
        }
        const serializedEvidence = JSON.stringify(evidence)
        if (serializedEvidence.length > 100_000) {
          response.status(422).json({ message: 'evidence завеликий.' })
          return
        }
        values.evidence = evidence
      }
      if (Object.hasOwn(request.body, 'releasedAt')) {
        const releasedAt = request.body.releasedAt
        if (releasedAt !== null && Number.isNaN(Date.parse(releasedAt))) {
          response.status(422).json({ message: 'releasedAt має бути ISO-датою або null.' })
          return
        }
        values.releasedAt = releasedAt
      }
      const taskStatus = cleanText(request.body.taskStatus)
      if (taskStatus && !allowedReleaseTaskStatuses.has(taskStatus)) {
        response.status(422).json({ message: 'Невідомий статус задачі після release.' })
        return
      }
      if (['released', 'blocked'].includes(values.status) && !taskStatus) {
        response.status(422).json({ message: 'Фінальний release-статус вимагає taskStatus.' })
        return
      }
      if (taskStatus && !['released', 'blocked'].includes(values.status)) {
        response.status(422).json({ message: 'taskStatus дозволений лише для фінального release-статусу.' })
        return
      }
      if (values.status === 'blocked' && taskStatus === 'done') {
        response.status(422).json({ message: 'Заблокований release не може закривати задачу.' })
        return
      }
      if (values.status === 'released' && taskStatus === 'blocked') {
        response.status(422).json({ message: 'Успішний release не може блокувати задачу.' })
        return
      }
      if (['released', 'blocked'].includes(existingRun.releaseStatus)) {
        response.status(409).json({ message: 'Фінальний release-state є незмінним.' })
        return
      }
      if (values.status === 'released') {
        const evidence = values.evidence ?? existingRun.releaseEvidence
        if (existingRun.releasePhase !== 'verifying' || values.phase !== 'released') {
          response.status(409).json({ message: 'released дозволений лише після фази verifying.' })
          return
        }
        if (!evidence?.deployment?.verifiedAt || !evidence?.deployment?.services) {
          response.status(409).json({ message: 'released вимагає збережений deployment evidence.' })
          return
        }
      }
      const updated = store.updateAgentRunRelease(request.params.id, values, taskStatus)
      response.json(publicAgentRun(updated))
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/tasks/:id/agent-runs', async (request, response, next) => {
    try {
      const result = await store.enqueueAgentRun(randomUUID(), request.params.id, 'manual')
      if (result.status === 'task_not_found') {
        response.status(404).json({ message: 'Задачу не знайдено.' })
        return
      }
      if (result.status === 'release_active') {
        response.status(409).json({ message: 'Задача вже проходить release. Дочекайтеся ретесту або помилки release.' })
        return
      }
      response.status(result.created ? 202 : 200).json(await store.find(request.params.id))
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/tasks/:id/agent-runs/reorder', async (request, response, next) => {
    try {
      const direction = String(request.body?.direction ?? '')
      if (!['up', 'down', 'top'].includes(direction)) {
        response.status(400).json({ message: 'Напрямок має бути up, down або top.' })
        return
      }

      const run = store.reorderQueuedRun(request.params.id, direction)
      if (!run) {
        response.status(404).json({ message: 'Задача не стоїть у черзі.' })
        return
      }

      response.json(await store.find(request.params.id))
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/tasks/:id/agent-runs/stop', async (request, response, next) => {
    try {
      const revert = request.body?.revert === true
      const result = store.requestStop(request.params.id, { revert })
      if (!result) {
        response.status(404).json({ message: 'Немає активного або чергового запуску для цієї задачі.' })
        return
      }

      if (result.stoppedImmediately && revert) {
        // Ран ще не стартував — worktree міг лишитись від попередньої спроби,
        // прибирання робить воркер, тож лишаємо позначку для нього.
        store.updateAgentRun(result.run.id, { error: 'Знято з черги оператором (із відкатом).' })
      }
      if (result.stoppedImmediately) {
        await store.patch(request.params.id, { status: 'new' })
      }

      response.json(await store.find(request.params.id))
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/tasks/:id/agent-runs/resume', async (request, response, next) => {
    try {
      const task = await store.find(request.params.id)
      if (!task) {
        response.status(404).json({ message: 'Задачу не знайдено.' })
        return
      }

      // Живий run не можна «перебити» другим агентом у тому самому worktree.
      // Resume дозволяємо лише коли heartbeat справді протух.
      if (task.agentRun?.status === 'running') {
        const staleBefore = new Date(Date.now() - agentRunStaleMs).toISOString()
        if (!store.releaseStaleRunningRun(request.params.id, staleBefore)) {
          response.status(409).json({ message: 'AI-запуск ще працює. Спочатку зупиніть його або дочекайтеся завершення.' })
          return
        }
      }

      const result = await store.enqueueAgentRun(randomUUID(), request.params.id, 'manual')
      if (result.status === 'task_not_found') {
        response.status(404).json({ message: 'Задачу не знайдено.' })
        return
      }
      if (result.status === 'release_active') {
        response.status(409).json({ message: 'Задача вже проходить release. Дочекайтеся ретесту або помилки release.' })
        return
      }

      response.status(result.created ? 202 : 200).json(await store.find(request.params.id))
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/tasks/:id/attachments', upload.array('attachments', 6), async (request, response, next) => {
    try {
      if (!request.files.length) {
        response.status(400).json({ message: 'Оберіть хоча б одне зображення або відео.' })
        return
      }
      const mediaError = getMediaValidationError(request.files)
      if (mediaError) {
        await removeUploadedFiles(request.files)
        response.status(400).json({ message: mediaError })
        return
      }

      const task = await store.addAttachments(
        request.params.id,
        request.files.map(serializeAttachment),
      )

      if (!task) {
        await removeUploadedFiles(request.files)
        response.status(404).json({ message: 'Задачу не знайдено.' })
        return
      }
      response.status(201).json(task)
    } catch (error) {
      await removeUploadedFiles(request.files)
      next(error)
    }
  })

  app.delete('/api/tasks/:id/attachments/:attachmentId', async (request, response, next) => {
    try {
      const result = await store.removeAttachment(request.params.id, request.params.attachmentId)

      if (result.status === 'task_not_found') {
        response.status(404).json({ message: 'Задачу не знайдено.' })
        return
      }
      if (result.status === 'attachment_not_found') {
        response.status(404).json({ message: 'Файл не знайдено.' })
        return
      }

      const fileName = path.basename(result.attachment.url)
      await unlink(path.join(uploadsDirectory, fileName)).catch(() => undefined)
      response.json(result.task)
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/tasks/:id', async (request, response, next) => {
    try {
      const removedTask = await store.delete(request.params.id)

      if (!removedTask) {
        response.status(404).json({ message: 'Задачу не знайдено.' })
        return
      }

      await Promise.all(
        removedTask.attachments.map((attachment) =>
          unlink(path.join(uploadsDirectory, path.basename(attachment.url))).catch(() => undefined),
        ),
      )
      response.status(204).end()
    } catch (error) {
      next(error)
    }
  })

  if (process.env.NODE_ENV === 'production') {
    const distDirectory = path.join(rootDirectory, 'dist')
    app.use(express.static(distDirectory))
    app.get('/{*splat}', (_request, response) => {
      response.sendFile(path.join(distDirectory, 'index.html'))
    })
  }

  app.use((error, _request, response, _next) => {
    if (error instanceof multer.MulterError) {
      const isVoiceUpload = error.field === 'audio'
      const message = isVoiceUpload
        ? error.code === 'LIMIT_FILE_SIZE'
          ? 'Голосовий запис завеликий. Максимальний розмір — 25 МБ.'
          : 'Цей формат аудіо не підтримується. Запишіть голос ще раз у цьому браузері.'
        : error.code === 'LIMIT_FILE_SIZE'
          ? 'Файл завеликий. Зображення — до 10 МБ, відео — до 200 МБ.'
          : 'Можна завантажити до 6 файлів: JPG, PNG, WEBP, GIF, AVIF, MP4, WEBM або MOV.'
      response.status(400).json({ message })
      return
    }

    if (error instanceof TranscriptionError) {
      response.status(error.status).json({ message: error.message })
      return
    }

    console.error(error)
    response.status(500).json({ message: 'Не вдалося виконати запит. Спробуйте ще раз.' })
  })

  return app
}
