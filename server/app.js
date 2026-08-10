import { randomUUID } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import multer from 'multer'
import { BuildNumberSource } from './build-source.js'
import { TaskStore } from './store.js'
import { TopologyService } from './topology.js'
import { TranscriptionError, transcribeAudioWithShell } from './transcription.js'

const allowedStatuses = new Set(['new', 'in_progress', 'ready_for_retest', 'review_again', 'done', 'blocked'])
const allowedPriorities = new Set(['low', 'medium', 'high', 'critical'])
const allowedProjects = new Set(['console', 'ecommerce'])
const allowedReleaseStatuses = new Set(['pending', 'processing', 'retrying', 'released', 'blocked'])
const allowedReleaseTaskStatuses = new Set(['ready_for_retest', 'done', 'blocked'])
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
  app.use('/uploads', express.static(uploadsDirectory, { maxAge: '7d', immutable: true }))

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true })
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

  app.get('/api/tasks', async (_request, response, next) => {
    try {
      response.json(await store.all())
    } catch (error) {
      next(error)
    }
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
      if (!store.findAgentRun(request.params.id)) {
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
      if (values.status === 'blocked' && taskStatus !== 'blocked') {
        response.status(422).json({ message: 'Заблокований release вимагає taskStatus=blocked.' })
        return
      }
      if (values.status === 'released' && taskStatus === 'blocked') {
        response.status(422).json({ message: 'Успішний release не може блокувати задачу.' })
        return
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
