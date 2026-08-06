import { randomUUID } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import multer from 'multer'
import { TaskStore } from './store.js'

const allowedStatuses = new Set(['new', 'in_progress', 'ready_for_retest', 'review_again', 'done', 'blocked'])
const allowedPriorities = new Set(['low', 'medium', 'high', 'critical'])
const allowedProjects = new Set(['console', 'ecommerce'])
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

function createFileName(file) {
  return `${Date.now()}-${randomUUID()}${allowedMediaTypes.get(file.mimetype).extension}`
}

function cleanText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
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
  if (reviewComment.length > 5000) errors.push('Коментар для AI має бути коротшим за 5000 символів.')
  if (area.length > 80) errors.push('Назва розділу має бути коротшою за 80 символів.')
  if (assignee.length > 80) errors.push('Ім’я виконавця має бути коротшим за 80 символів.')
  if (status && !allowedStatuses.has(status)) errors.push('Невідомий статус задачі.')
  if (priority && !allowedPriorities.has(priority)) errors.push('Невідомий пріоритет задачі.')
  if (project && !allowedProjects.has(project)) errors.push('Невідомий проєкт задачі.')

  return {
    errors,
    values: { title, description, siteUrl, notes, reviewComment, area, project, status, priority, assignee },
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
  const store = options.store ?? new TaskStore(dataDirectory)

  await mkdir(uploadsDirectory, { recursive: true })
  await store.ensureReady()
  store.ensureBuild(buildNumber)

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

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))
  app.use('/uploads', express.static(uploadsDirectory, { maxAge: '7d', immutable: true }))

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true })
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
      response.json(await store.ensureBuild(buildNumber))
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
        reviewComment: values.reviewComment,
        area: values.area || 'Загальне',
        project: values.project || 'console',
        status: values.status || 'new',
        priority: values.priority || 'medium',
        assignee: values.assignee || 'Не призначено',
      }, request.files.map(serializeAttachment))

      if (['ready_for_retest', 'done'].includes(task.status)) {
        store.markTaskProcessed(buildNumber, task.id, 'manual')
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
      for (const key of ['title', 'description', 'siteUrl', 'notes', 'reviewComment', 'area', 'project', 'status', 'priority', 'assignee']) {
        if (Object.hasOwn(request.body, key)) patch[key] = values[key]
      }
      if (Object.hasOwn(patch, 'project') && !patch.project) delete patch.project
      await store.patch(request.params.id, patch)

      if (['ready_for_retest', 'done'].includes(values.status) && existingTask.status !== values.status) {
        store.markTaskProcessed(buildNumber, request.params.id, 'manual')
      }

      if (startsReviewRun) {
        store.enqueueAgentRun(randomUUID(), request.params.id, 'review_again')
      }
      response.json(await store.find(request.params.id))
    } catch (error) {
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
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? 'Файл завеликий. Зображення — до 10 МБ, відео — до 200 МБ.'
        : 'Можна завантажити до 6 файлів: JPG, PNG, WEBP, GIF, AVIF, MP4, WEBM або MOV.'
      response.status(400).json({ message })
      return
    }

    console.error(error)
    response.status(500).json({ message: 'Не вдалося виконати запит. Спробуйте ще раз.' })
  })

  return app
}
