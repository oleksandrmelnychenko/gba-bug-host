import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import request from 'supertest'
import { createApp } from '../server/app.js'
import { hashPassword } from '../server/auth.js'
import { TaskStore, getSeedTasks } from '../server/store.js'
import { TranscriptionError, transcribeAudioWithShell } from '../server/transcription.js'

async function withTestApp(run, appOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-bug-host-'))
  const dataDirectory = path.join(root, 'data')
  const uploadsDirectory = path.join(root, 'uploads')
  const store = new TaskStore(dataDirectory)

  try {
    const app = await createApp({
      rootDirectory: root,
      dataDirectory,
      uploadsDirectory,
      store,
      authRequired: false,
      internalApiToken: 'test-internal-token',
      ...appOptions,
    })
    store.transaction(() => {
      for (const task of getSeedTasks()) store.insertTask(task)
    })
    await run({ app, dataDirectory, uploadsDirectory, store })
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

test('API повертає стартові задачі та health status', async () => {
  await withTestApp(async ({ app }) => {
    const health = await request(app).get('/api/health').expect(200)
    assert.deepEqual(health.body, { ok: true })

    const response = await request(app).get('/api/tasks').expect(200)
    assert.equal(response.body.length, 5)
    assert.equal(response.body[0].id, 'BUG-1051')
  })
})

test('персональний логін захищає Desk і визначає автора коментаря', async () => {
  await withTestApp(async ({ app, store }) => {
    const password = 'Strong-Test-Password-42!'
    const user = store.upsertUser({
      id: 'user-oleksandr',
      email: 'oleksandr@qa-desk.com',
      displayName: 'Олександр',
      passwordHash: await hashPassword(password),
    })
    const secondUser = store.upsertUser({
      id: 'user-alona',
      email: 'alona@qa-desk.com',
      displayName: 'Альона',
      passwordHash: await hashPassword(password),
    })
    store.markAllCommentsRead(user.id)
    store.markAllCommentsRead(secondUser.id)
    const agent = request.agent(app)
    const secondAgent = request.agent(app)

    await request(app).get('/api/health').expect(200)
    await request(app).get('/api/builds/current').expect(200)
    await request(app).get('/api/tasks').expect(401)
    await request(app).get('/uploads/private.png').expect(401)
    await request(app).post('/api/system/heartbeat').send({ units: {} }).expect(401)
    await request(app)
      .get('/api/tasks')
      .set('Authorization', 'Bearer test-internal-token')
      .expect(200)
    await request(app)
      .post('/api/system/heartbeat')
      .set('Authorization', 'Bearer test-internal-token')
      .send({ units: {}, host: 'test-host' })
      .expect(200)
    await agent
      .post('/api/auth/login')
      .send({ email: user.email, password: 'wrong-password' })
      .expect(401)
    await agent
      .post('/api/auth/login')
      .send({ email: user.email, password })
      .expect(200)
      .expect(({ body }) => {
        assert.equal(body.displayName, 'Олександр')
        assert.equal(Object.hasOwn(body, 'passwordHash'), false)
      })

    await agent.get('/api/auth/me').expect(200).expect(({ body }) => {
      assert.equal(body.email, user.email)
      assert.equal(body.displayName, 'Олександр')
    })
    const createdTask = await agent
      .post('/api/tasks')
      .field('title', 'Задача авторизованого користувача')
      .expect(201)
    assert.equal(createdTask.body.createdByUserId, user.id)
    assert.equal(createdTask.body.createdByName, user.displayName)

    const comment = await agent
      .post('/api/tasks/BUG-1051/comments')
      .send({ author: 'Підмінений автор', body: 'Коментар від залогіненого користувача.', parentId: null })
      .expect(201)
    assert.equal(comment.body.author, 'Олександр')
    assert.equal(comment.body.authorUserId, user.id)

    await secondAgent.post('/api/auth/login').send({ email: secondUser.email, password }).expect(200)
    await agent.get('/api/comments/unread').expect(200).expect(({ body }) => assert.equal(body.total, 0))
    const unread = await secondAgent.get('/api/comments/unread').expect(200)
    assert.equal(unread.body.total, 1)
    assert.equal(unread.body.comments[0].id, comment.body.id)
    assert.equal(unread.body.comments[0].taskId, 'BUG-1051')
    assert.equal(unread.body.comments[0].taskTitle, 'Пошук падає після очищення поля')
    await secondAgent.post('/api/tasks/BUG-1051/comments/read').expect(200).expect(({ body }) => {
      assert.equal(body.total, 0)
      assert.deepEqual(body.comments, [])
    })

    await agent.post('/api/auth/logout').expect(204)
    await agent.get('/api/auth/me').expect(401)
  }, { authRequired: true, secureCookies: false, internalApiToken: 'test-internal-token' })
})

test('API перетворює голосовий запис на текст без збереження аудіо', async () => {
  let receivedFile
  await withTestApp(async ({ app, uploadsDirectory }) => {
    const response = await request(app)
      .post('/api/transcriptions')
      .attach('audio', Buffer.from('fake-webm-audio'), {
        filename: 'voice.webm',
        contentType: 'audio/webm',
      })
      .expect(200)

    assert.deepEqual(response.body, { text: 'Після натискання кнопки продаж не зберігається.' })
    assert.equal(receivedFile.originalname, 'voice.webm')
    assert.equal(receivedFile.mimetype, 'audio/webm')
    assert.equal(receivedFile.buffer.toString(), 'fake-webm-audio')
    assert.deepEqual(await readdir(uploadsDirectory), [])
  }, {
    transcribeAudio: async (file) => {
      receivedFile = file
      return 'Після натискання кнопки продаж не зберігається.'
    },
  })
})

test('API перевіряє голосовий файл до транскрипції', async () => {
  await withTestApp(async ({ app }) => {
    await request(app)
      .post('/api/transcriptions')
      .expect(400)
      .expect(({ body }) => assert.match(body.message, /запишіть голосове повідомлення/i))

    await request(app)
      .post('/api/transcriptions')
      .attach('audio', Buffer.from('not-audio'), { filename: 'voice.txt', contentType: 'text/plain' })
      .expect(400)
      .expect(({ body }) => assert.match(body.message, /формат аудіо не підтримується/i))
  })
})

test('локальна транскрипція запускає shell worker і видаляє тимчасове аудіо', async () => {
  let temporaryAudioPath = ''
  const transcript = await transcribeAudioWithShell({
    buffer: Buffer.from('audio'),
    mimetype: 'audio/webm',
    originalname: 'voice.webm',
  }, {
    pythonBinary: '/opt/voice/bin/python',
    scriptPath: '/app/server/transcribe-local.py',
    runProcess: async (command, args, options) => {
      assert.equal(command, '/opt/voice/bin/python')
      assert.equal(args[0], '/app/server/transcribe-local.py')
      assert.equal(options.env, process.env)
      temporaryAudioPath = args[1]
      assert.equal(path.extname(temporaryAudioPath), '.webm')
      assert.equal((await readFile(temporaryAudioPath)).toString(), 'audio')
      return { code: 0, stdout: '{"text":"Розпізнаний опис."}\n', stderr: '', timedOut: false }
    },
  })

  assert.equal(transcript, 'Розпізнаний опис.')
  assert.equal(existsSync(temporaryAudioPath), false)
  await assert.rejects(
    () => transcribeAudioWithShell(
      { buffer: Buffer.from('audio'), mimetype: 'audio/webm', originalname: 'voice.webm' },
      {
        logError: () => undefined,
        runProcess: async () => ({ code: 1, stdout: '', stderr: "ModuleNotFoundError: No module named 'faster_whisper'", timedOut: false }),
      },
    ),
    (error) => error instanceof TranscriptionError && error.status === 503,
  )
})

test('API створює задачу зі скріншотом і оновлює її статус', async () => {
  await withTestApp(async ({ app, uploadsDirectory }) => {
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4GAAAAAASUVORK5CYII=',
      'base64',
    )

    const created = await request(app)
      .post('/api/tasks')
      .field('title', 'Нова тестова помилка')
      .field('description', 'Сценарій для API тесту')
      .field('siteUrl', 'qa.example.com/orders/42')
      .field('notes', 'POST /api/orders\nResponse: 500')
      .field('staffComments', 'Олена перевірить виправлення після обіду.')
      .field('area', 'Тестування')
      .field('priority', 'high')
      .field('status', 'new')
      .field('qaStatus', 'not done')
      .field('assignee', 'QA')
      .attach('attachments', tinyPng, { filename: 'proof.png', contentType: 'image/png' })
      .expect(201)

    assert.equal(created.body.id, 'BUG-1052')
    assert.equal(created.body.attachments.length, 1)
    assert.equal(created.body.attachments[0].kind, 'image')
    assert.equal(created.body.siteUrl, 'https://qa.example.com/orders/42')
    assert.equal(created.body.notes, 'POST /api/orders\nResponse: 500')
    assert.equal(created.body.staffComments, 'Олена перевірить виправлення після обіду.')
    assert.equal(created.body.qaStatus, 'not done')
    assert.equal(created.body.createdByUserId, null)
    assert.equal(created.body.createdByName, 'Команда')
    assert.equal(created.body.agentRun.status, 'queued')
    assert.equal(created.body.agentRun.attempt, 1)
    assert.equal(created.body.agentRun.inputSnapshot.staffComments, 'Олена перевірить виправлення після обіду.')
    assert.equal(created.body.agentRun.inputSnapshot.comments.length, 1)
    assert.equal(created.body.agentRun.inputSnapshot.comments[0].body, 'Олена перевірить виправлення після обіду.')
    assert.equal(Object.hasOwn(created.body.agentRun.inputSnapshot, 'qaStatus'), false)
    const initialComments = await request(app).get(`/api/tasks/${created.body.id}/comments`).expect(200)
    assert.equal(initialComments.body.length, 1)
    assert.equal(initialComments.body[0].author, 'Команда')
    assert.equal(initialComments.body[0].body, 'Олена перевірить виправлення після обіду.')
    assert.equal(initialComments.body[0].parentId, null)
    assert.equal(
      existsSync(path.join(uploadsDirectory, path.basename(created.body.attachments[0].url))),
      true,
    )

    const updated = await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .send({ status: 'ready_for_retest', qaStatus: 'done' })
      .expect(200)

    assert.equal(updated.body.status, 'ready_for_retest')
    assert.equal(updated.body.qaStatus, 'done')
  })
})

test('API приймає JSON, PDF, XML, XLS та XLSX як докази і зберігає безпечні типи файлів', async () => {
  await withTestApp(async ({ app, uploadsDirectory }) => {
    const created = await request(app)
      .post('/api/tasks')
      .field('title', 'Chrome Autorecord сценарії')
      .field('area', 'E2E')
      .attach('attachments', Buffer.from('{"title":"sale"}'), {
        filename: 'sale.json',
        contentType: 'application/json',
      })
      .attach('attachments', Buffer.from('%PDF-1.4\n%%EOF'), {
        filename: 'scenario.pdf',
        contentType: 'application/pdf',
      })
      .attach('attachments', Buffer.from('<scenario name="income"/>'), {
        filename: 'income.xml',
        contentType: 'application/octet-stream',
      })
      .attach('attachments', Buffer.from('legacy-excel-workbook'), {
        filename: 'CCD_25UA400040016490U5 — копия (3).xls',
        contentType: 'application/vnd.ms-excel',
      })
      .attach('attachments', Buffer.from('openxml-excel-workbook'), {
        filename: 'scenario.xlsx',
        contentType: 'application/octet-stream',
      })
      .expect(201)

    assert.deepEqual(
      created.body.attachments.map(({ kind, name, type }) => ({ kind, name, type })),
      [
        { kind: 'document', name: 'sale.json', type: 'application/json' },
        { kind: 'document', name: 'scenario.pdf', type: 'application/pdf' },
        { kind: 'document', name: 'income.xml', type: 'application/xml' },
        {
          kind: 'document',
          name: 'CCD_25UA400040016490U5 — копия (3).xls',
          type: 'application/vnd.ms-excel',
        },
        {
          kind: 'document',
          name: 'scenario.xlsx',
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ],
    )
    assert.deepEqual(
      (await readdir(uploadsDirectory)).map((name) => path.extname(name)).sort(),
      ['.json', '.pdf', '.xls', '.xlsx', '.xml'],
    )

    for (const attachment of created.body.attachments) {
      await request(app).get(attachment.url).expect(200)
    }
  })
})

test('API відхиляє невідомий binary-файл навіть із загальним MIME', async () => {
  await withTestApp(async ({ app, uploadsDirectory }) => {
    const response = await request(app)
      .post('/api/tasks')
      .field('title', 'Непідтриманий файл')
      .attach('attachments', Buffer.from('binary'), {
        filename: 'payload.exe',
        contentType: 'application/octet-stream',
      })
      .expect(400)

    assert.match(response.body.message, /JSON, PDF, XML, XLS або XLSX/u)
    assert.deepEqual(await readdir(uploadsDirectory), [])
  })
})

test('API зберігає дерево внутрішніх коментарів і додає його до наступного AI snapshot', async () => {
  await withTestApp(async ({ app }) => {
    const rootComment = await request(app)
      .post('/api/tasks/BUG-1051/comments')
      .send({ author: ' Олена ', body: ' Перевірю сценарій на касі. ' })
      .expect(201)

    assert.equal(rootComment.body.author, 'Олена')
    assert.equal(rootComment.body.body, 'Перевірю сценарій на касі.')
    assert.equal(rootComment.body.parentId, null)

    const reply = await request(app)
      .post('/api/tasks/BUG-1051/comments')
      .send({ author: 'Ігор', body: 'Додай, будь ласка, відео.', parentId: rootComment.body.id })
      .expect(201)

    assert.equal(reply.body.parentId, rootComment.body.id)
    const comments = await request(app).get('/api/tasks/BUG-1051/comments').expect(200)
    assert.deepEqual(comments.body.map(({ author, parentId }) => ({ author, parentId })), [
      { author: 'Олена', parentId: null },
      { author: 'Ігор', parentId: rootComment.body.id },
    ])

    await request(app)
      .post('/api/tasks/BUG-1050/comments')
      .send({ author: 'Ігор', body: 'Не в ту задачу.', parentId: rootComment.body.id })
      .expect(400)
    await request(app)
      .post('/api/tasks/BUG-1051/comments')
      .send({ author: '', body: '' })
      .expect(400)
    await request(app).get('/api/tasks/BUG-9999/comments').expect(404)

    const queued = await request(app)
      .post('/api/tasks/BUG-1051/agent-runs')
      .expect(202)
    assert.deepEqual(
      queued.body.agentRun.inputSnapshot.comments.map(({ id, parentId, author, body }) => ({ id, parentId, author, body })),
      [
        { id: rootComment.body.id, parentId: null, author: 'Олена', body: 'Перевірю сценарій на касі.' },
        { id: reply.body.id, parentId: rootComment.body.id, author: 'Ігор', body: 'Додай, будь ласка, відео.' },
      ],
    )
  })
})

test('SQLite автоматично додає поля задачі та snapshots AI-запусків до існуючої схеми', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-bug-host-migration-'))
  const dataDirectory = path.join(root, 'data')
  const databasePath = path.join(dataDirectory, 'gba-qa.sqlite')
  await mkdir(dataDirectory, { recursive: true })

  const legacyDatabase = new DatabaseSync(databasePath)
  legacyDatabase.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      area TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      assignee TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      kind TEXT NOT NULL
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      worktree_path TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO tasks VALUES (
      'BUG-1001', 'Стара задача', '', 'Продаж', 'new', 'medium',
      'Не призначено', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO agent_runs VALUES (
      'RUN-LEGACY', 'BUG-1001', 'manual', 'completed', 1, '', '', 'Готово', '', '',
      '2026-01-01T01:00:00.000Z', '2026-01-01T01:00:00.000Z', '2026-01-01T01:05:00.000Z', '2026-01-01T01:05:00.000Z'
    );
  `)
  legacyDatabase.close()

  const store = new TaskStore(dataDirectory)
  try {
    await store.ensureReady()
    const task = store.find('BUG-1001')
    assert.equal(task.siteUrl, '')
    assert.equal(task.notes, '')
    assert.equal(task.staffComments, '')
    assert.equal(task.qaStatus, '')
    assert.equal(task.createdByUserId, null)
    assert.equal(task.createdByName, '')
    assert.equal(task.reviewComment, '')
    assert.equal(task.agentRun.reviewComment, '')
    assert.equal(task.agentRun.inputSnapshot, null)
    assert.equal(task.agentRun.workerId, '')
    assert.equal(task.agentRun.heartbeatAt, null)
    assert.equal(task.agentRun.releaseStatus, '')
    assert.equal(task.agentRun.releaseAttempts, 0)
    assert.deepEqual(task.agentRun.releaseRepositories, [])
    assert.equal(task.agentRun.releasePhase, '')
    assert.deepEqual(task.agentRun.releaseEvidence, {})
    assert.equal(store.findAgentRun('RUN-LEGACY').contextSnapshot, '')
    assert.equal(store.findAgentRun('RUN-LEGACY').codexSessionId, '')

    const taskWithDocument = store.addAttachments('BUG-1001', [{
      id: 'legacy-document',
      name: 'scenario.json',
      url: '/uploads/scenario.json',
      type: 'application/json',
      size: 2,
      kind: 'document',
    }])
    assert.equal(taskWithDocument.attachments[0].kind, 'document')

    const updated = store.patch('BUG-1001', {
      siteUrl: 'https://example.com/problem',
      notes: 'GET /api/products → 500',
      staffComments: 'Перевіряє команда підтримки.',
      qaStatus: 'done',
      reviewComment: 'Кнопка все ще повертає 500.',
    })
    assert.equal(updated.siteUrl, 'https://example.com/problem')
    assert.equal(updated.notes, 'GET /api/products → 500')
    assert.equal(updated.staffComments, 'Перевіряє команда підтримки.')
    assert.equal(updated.qaStatus, 'done')
    assert.equal(updated.reviewComment, 'Кнопка все ще повертає 500.')

    store.close()
    const reopenedStore = new TaskStore(dataDirectory)
    await reopenedStore.ensureReady()
    assert.deepEqual(reopenedStore.commentsForTask('BUG-1001').map(({ author, body }) => ({ author, body })), [
      { author: 'Команда (імпорт)', body: 'Перевіряє команда підтримки.' },
    ])
    await reopenedStore.ensureReady()
    assert.equal(reopenedStore.commentsForTask('BUG-1001').length, 1)
    reopenedStore.database
      .prepare("UPDATE tasks SET created_by_name = 'Імпорт', notes = '' WHERE id = 'BUG-1001'")
      .run()
    reopenedStore.close()

    const sanitizedStore = new TaskStore(dataDirectory)
    await sanitizedStore.ensureReady()
    assert.equal(sanitizedStore.find('BUG-1001').createdByName, '')
    sanitizedStore.database
      .prepare("UPDATE tasks SET created_by_name = 'Імпорт', notes = '[sentinel:test]' WHERE id = 'BUG-1001'")
      .run()
    sanitizedStore.close()

    const systemStore = new TaskStore(dataDirectory)
    await systemStore.ensureReady()
    assert.equal(systemStore.find('BUG-1001').createdByName, 'Система')
    systemStore.close()
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('SQLite зберігає задачу та відео після повторного відкриття бази', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-bug-host-persistence-'))
  const dataDirectory = path.join(root, 'data')
  const uploadsDirectory = path.join(root, 'uploads')
  const firstStore = new TaskStore(dataDirectory)

  try {
    const firstApp = await createApp({ rootDirectory: root, dataDirectory, uploadsDirectory, store: firstStore, authRequired: false })
    const created = await request(firstApp)
      .post('/api/tasks')
      .field('title', 'Відео помилки зберігається')
      .field('area', 'Відеотест')
      .attach('attachments', Buffer.from('fake-mp4-content'), {
        filename: 'bug.mp4',
        contentType: 'video/mp4',
      })
      .expect(201)

    assert.equal(created.body.attachments[0].kind, 'video')
    firstStore.close()

    const secondStore = new TaskStore(dataDirectory)
    try {
      const secondApp = await createApp({ rootDirectory: root, dataDirectory, uploadsDirectory, store: secondStore, authRequired: false })
      const tasks = await request(secondApp).get('/api/tasks').expect(200)
      const restoredTask = tasks.body.find((task) => task.id === created.body.id)

      assert.equal(restoredTask.title, 'Відео помилки зберігається')
      assert.equal(restoredTask.attachments[0].kind, 'video')
      assert.equal(restoredTask.agentRun.inputSnapshot.title, 'Відео помилки зберігається')
      assert.equal(restoredTask.agentRun.inputSnapshot.attachments[0].name, 'bug.mp4')
      assert.equal(existsSync(path.join(dataDirectory, 'gba-qa.sqlite')), true)
    } finally {
      secondStore.close()
    }
  } finally {
    firstStore.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('API ставить Codex job у чергу та повторно реагує на спеціальний статус', async () => {
  await withTestApp(async ({ app, store }) => {
    const firstRun = await request(app)
      .post('/api/tasks/BUG-1051/agent-runs')
      .expect(202)

    assert.equal(firstRun.body.agentRun.status, 'queued')
    assert.equal(firstRun.body.agentRun.trigger, 'manual')
    assert.equal(firstRun.body.agentRun.attempt, 1)
    assert.equal(firstRun.body.agentRun.reviewComment, '')
    assert.equal(firstRun.body.agentRun.inputSnapshot.title, 'Пошук падає після очищення поля')

    const duplicate = await request(app)
      .post('/api/tasks/BUG-1051/agent-runs')
      .expect(200)
    assert.equal(duplicate.body.agentRun.id, firstRun.body.agentRun.id)

    store.updateAgentRun(firstRun.body.agentRun.id, {
      status: 'completed',
      summary: 'Перша спроба завершена.',
      finishedAt: new Date().toISOString(),
    })
    store.updateAgentRunRelease(firstRun.body.agentRun.id, { status: 'blocked' })

    const missingComment = await request(app)
      .patch('/api/tasks/BUG-1051')
      .send({ status: 'review_again' })
      .expect(400)

    assert.match(missingComment.body.message, /що саме залишилося невиправленим/i)

    const reviewAgain = await request(app)
      .patch('/api/tasks/BUG-1051')
      .send({
        status: 'review_again',
        reviewComment: 'Поле очищується, але білий екран усе ще з’являється після другого пошуку.',
      })
      .expect(200)

    assert.equal(reviewAgain.body.status, 'review_again')
    assert.equal(reviewAgain.body.reviewComment, 'Поле очищується, але білий екран усе ще з’являється після другого пошуку.')
    assert.equal(reviewAgain.body.agentRun.status, 'queued')
    assert.equal(reviewAgain.body.agentRun.trigger, 'review_again')
    assert.equal(reviewAgain.body.agentRun.attempt, 2)
    assert.equal(reviewAgain.body.agentRun.reviewComment, 'Поле очищується, але білий екран усе ще з’являється після другого пошуку.')
    assert.equal(reviewAgain.body.agentRun.inputSnapshot.reviewComment, reviewAgain.body.agentRun.reviewComment)

    const history = await request(app)
      .get('/api/tasks/BUG-1051/agent-runs')
      .expect(200)
    assert.equal(history.body.length, 2)
    assert.equal(history.body[0].attempt, 2)
    assert.equal(history.body[0].inputSnapshot.status, 'review_again')

    store.patch('BUG-1051', { reviewComment: 'Новіший коментар не має змінити старий запуск.' })
    const preservedHistory = await request(app)
      .get('/api/tasks/BUG-1051/agent-runs')
      .expect(200)
    assert.equal(preservedHistory.body[0].reviewComment, 'Поле очищується, але білий екран усе ще з’являється після другого пошуку.')
  })
})

test('повторний AI-запуск атомарно додає новий скріншот у snapshot', async () => {
  await withTestApp(async ({ app, store, uploadsDirectory }) => {
    const firstRun = await request(app)
      .post('/api/tasks/BUG-1051/agent-runs')
      .expect(202)
    store.updateAgentRun(firstRun.body.agentRun.id, {
      status: 'completed',
      summary: 'Перша спроба завершена.',
      finishedAt: new Date().toISOString(),
    })
    store.updateAgentRunRelease(firstRun.body.agentRun.id, { status: 'blocked' })

    await request(app)
      .post('/api/tasks/BUG-1051/review-again')
      .attach('attachments', Buffer.from('temporary-image'), {
        filename: 'invalid-review.png',
        contentType: 'image/png',
      })
      .expect(400)
    assert.deepEqual(await readdir(uploadsDirectory), [])

    const reviewAgain = await request(app)
      .post('/api/tasks/BUG-1051/review-again')
      .field('reviewComment', 'Після виправлення форма все ще падає на другому кроці.')
      .attach('attachments', Buffer.from('review-image'), {
        filename: 'second-step.png',
        contentType: 'image/png',
      })
      .expect(202)

    assert.equal(reviewAgain.body.status, 'review_again')
    assert.equal(reviewAgain.body.attachments.length, 1)
    assert.equal(reviewAgain.body.attachments[0].name, 'second-step.png')
    assert.equal(reviewAgain.body.agentRun.trigger, 'review_again')
    assert.equal(reviewAgain.body.agentRun.inputSnapshot.attachments.length, 1)
    assert.equal(reviewAgain.body.agentRun.inputSnapshot.attachments[0].name, 'second-step.png')
    assert.deepEqual(await readdir(uploadsDirectory), [path.basename(reviewAgain.body.attachments[0].url)])
  })
})

test('API запускає Codex без окремого токена', async () => {
  await withTestApp(async ({ app }) => {
    const created = await request(app)
      .post('/api/tasks')
      .field('title', 'Запуск без токена')
      .expect(201)
    assert.equal(created.body.agentRun.status, 'queued')

    const rerun = await request(app)
      .post('/api/tasks/BUG-1051/agent-runs')
      .expect(202)
    assert.equal(rerun.body.agentRun.status, 'queued')
  })
})

test('API показує баги, опрацьовані в поточному build', async () => {
  await withTestApp(async ({ app }) => {
    const emptyBuild = await request(app).get('/api/builds/current').expect(200)
    assert.equal(emptyBuild.body.number, '0.1.0-local')
    assert.equal(emptyBuild.body.bugs.length, 0)

    await request(app)
      .patch('/api/tasks/BUG-1051')
      .send({ status: 'ready_for_retest' })
      .expect(200)

    const waiting = await request(app).get('/api/builds/current').expect(200)
    assert.equal(waiting.body.bugs.length, 0)
    assert.equal(waiting.body.pending.length, 1)
    assert.equal(waiting.body.pending[0].id, 'BUG-1051')
    assert.equal(waiting.body.pending[0].statusAtProcessing, 'ready_for_retest')
    assert.equal(waiting.body.pending[0].source, 'manual')
  })
})

test('наступний build забирає собі виправлення, що чекали на деплой', async () => {
  await withTestApp(async ({ app, store }) => {
    await request(app)
      .patch('/api/tasks/BUG-1051')
      .send({ status: 'ready_for_retest' })
      .expect(200)

    const shipped = store.ensureBuild('2026.08.06.2100')
    assert.equal(shipped.bugs.length, 1)
    assert.equal(shipped.bugs[0].id, 'BUG-1051')
    assert.equal(shipped.pending.length, 0)

    const older = store.currentBuild('0.1.0-local')
    assert.equal(older.bugs.length, 0)
  })
})

test('API відхиляє невалідну задачу', async () => {
  await withTestApp(async ({ app }) => {
    const response = await request(app)
      .post('/api/tasks')
      .field('title', 'x')
      .field('priority', 'unknown')
      .expect(400)

    assert.match(response.body.message, /щонайменше 3 символи/)
  })
})

test('API піднімає задачу в черзі Codex', async () => {
  await withTestApp(async ({ app, store }) => {
    const first = await request(app).post('/api/tasks').field('title', 'Перша у черзі').expect(201)
    const second = await request(app).post('/api/tasks').field('title', 'Друга у черзі').expect(201)
    const third = await request(app).post('/api/tasks').field('title', 'Третя у черзі').expect(201)

    const queueOrder = () => {
      const claimed = []
      let run
      while ((run = store.claimNextAgentRun())) claimed.push(run)
      for (const item of claimed) store.updateAgentRun(item.id, { status: 'queued' })
      return claimed.map((item) => item.taskId)
    }

    await request(app)
      .post(`/api/tasks/${third.body.id}/agent-runs/reorder`)
      .send({ direction: 'top' })
      .expect(200)

    assert.equal(queueOrder()[0], third.body.id)

    await request(app)
      .post(`/api/tasks/${second.body.id}/agent-runs/reorder`)
      .send({ direction: 'up' })
      .expect(200)

    const order = queueOrder()
    assert.equal(order.indexOf(second.body.id) < order.indexOf(first.body.id), true)

    await request(app)
      .post(`/api/tasks/${first.body.id}/agent-runs/reorder`)
      .send({ direction: 'сюди' })
      .expect(400)
  })
})

test('coding-черга чекає фінального release-state попередньої задачі', async () => {
  await withTestApp(async ({ app, store }) => {
    const first = await request(app).post('/api/tasks').field('title', 'Спочатку release').expect(201)
    const second = await request(app).post('/api/tasks').field('title', 'Потім наступний аналіз').expect(201)
    const claimed = store.claimNextAgentRun('worker-serial')
    assert.equal(claimed.taskId, first.body.id)

    store.patch(first.body.id, { status: 'in_progress' })
    store.updateAgentRun(claimed.id, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
    })
    assert.equal(store.claimNextAgentRun('worker-serial'), null)

    store.updateAgentRunRelease(claimed.id, { status: 'released' }, 'ready_for_retest')
    assert.equal(store.claimNextAgentRun('worker-serial')?.taskId, second.body.id)
  })
})

test('ручний done не запускає новий аудит поверх завершеної задачі', async () => {
  await withTestApp(async ({ app, store }) => {
    const created = await request(app).post('/api/tasks').field('title', 'Повторний аудит done').expect(201)
    const first = store.claimNextAgentRun('worker-old-release')
    store.updateAgentRun(first.id, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
    })
    store.patch(created.body.id, { status: 'done' })

    await request(app)
      .post(`/api/tasks/${created.body.id}/agent-runs`)
      .expect(409, { message: 'Закриту задачу не запускаємо повторно. Спочатку відкрийте її на повторну перевірку.' })
    assert.equal(store.find(created.body.id).status, 'done')
    assert.equal(store.agentRunsForTask(created.body.id).length, 1)
  })
})

test('новий аудит supersedes pending needs_review, але не активний release', async () => {
  await withTestApp(async ({ app, store }) => {
    const reviewable = await request(app).post('/api/tasks').field('title', 'Needs review без артефакту').expect(201)
    const oldRun = store.claimNextAgentRun('worker-review')
    store.updateAgentRun(oldRun.id, {
      status: 'needs_review',
      summary: 'Потрібне змістовне уточнення бізнес-правила.',
      finishedAt: new Date().toISOString(),
    })
    store.patch(reviewable.body.id, { status: 'blocked' })
    assert.equal(store.findAgentRun(oldRun.id).releaseStatus, 'pending')

    const rerun = await request(app)
      .post(`/api/tasks/${reviewable.body.id}/agent-runs`)
      .expect(202)
    assert.equal(rerun.body.agentRun.status, 'queued')
    assert.equal(rerun.body.agentRun.attempt, 2)
    assert.equal(store.findAgentRun(oldRun.id).releaseStatus, 'blocked')
    assert.match(store.findAgentRun(oldRun.id).releaseError, /замінено/)
    const supersedingRun = store.claimNextAgentRun('worker-review')
    assert.equal(supersedingRun.id, rerun.body.agentRun.id)
    store.failAgentRun(supersedingRun.id, reviewable.body.id, 'Fixture завершено.')
    assert.equal(store.findAgentRun(supersedingRun.id).releaseStatus, 'blocked')

    const activeRelease = await request(app).post('/api/tasks').field('title', 'Needs review у release').expect(201)
    const activeRun = store.claimNextAgentRun('worker-review')
    assert.equal(activeRun.taskId, activeRelease.body.id)
    store.updateAgentRun(activeRun.id, {
      status: 'needs_review',
      summary: 'Sandbox обмежив тест, release уже стартував.',
      finishedAt: new Date().toISOString(),
    })
    store.updateAgentRunRelease(activeRun.id, { status: 'processing' })
    store.patch(activeRelease.body.id, { status: 'blocked' })

    await request(app)
      .post(`/api/tasks/${activeRelease.body.id}/agent-runs`)
      .expect(409)
    assert.equal(store.findAgentRun(activeRun.id).releaseStatus, 'processing')
  })
})

test('API зупиняє чергову задачу і повертає її назад', async () => {
  await withTestApp(async ({ app, store }) => {
    const created = await request(app).post('/api/tasks').field('title', 'Задача для зупинки').expect(201)
    assert.equal(created.body.agentRun.status, 'queued')

    const stopped = await request(app)
      .post(`/api/tasks/${created.body.id}/agent-runs/stop`)
      .send({ revert: false })
      .expect(200)
    assert.equal(stopped.body.agentRun.status, 'blocked')
    assert.equal(stopped.body.agentRun.releaseStatus, 'blocked')
    assert.match(stopped.body.agentRun.error, /Знято з черги/)
    assert.equal(store.claimNextAgentRun(), null)

    const resumed = await request(app)
      .post(`/api/tasks/${created.body.id}/agent-runs/resume`)
      .expect(202)
    assert.equal(resumed.body.agentRun.status, 'queued')
    assert.equal(store.claimNextAgentRun()?.taskId, created.body.id)

    await request(app)
      .post('/api/tasks/BUG-9999/agent-runs/stop')
      .send({ revert: true })
      .expect(404)
  })
})

test('стоп із відкатом позначає керуючу команду для активного рану', async () => {
  await withTestApp(async ({ app, store }) => {
    const created = await request(app).post('/api/tasks').field('title', 'Активний ран').expect(201)
    const claimed = store.claimNextAgentRun()
    assert.equal(claimed.taskId, created.body.id)

    await request(app)
      .post(`/api/tasks/${created.body.id}/agent-runs/stop`)
      .send({ revert: true })
      .expect(200)

    assert.equal(store.readControl(claimed.id), 'stop_revert')
    assert.equal(store.findAgentRun(claimed.id).status, 'running')

    const finished = store.markStopped(claimed.id, { reverted: true })
    assert.equal(finished.status, 'blocked')
    assert.equal(finished.releaseStatus, 'blocked')
    assert.match(finished.error, /відкочено/)
  })
})

test('осиротілі running-рани повертаються в чергу на старті воркера', async () => {
  await withTestApp(async ({ app, store }) => {
    const created = await request(app).post('/api/tasks').field('title', 'Осиротілий ран').expect(201)
    const claimed = store.claimNextAgentRun()
    assert.equal(claimed.status, 'running')

    const requeued = store.requeueOrphanedRuns()
    assert.deepEqual(requeued, [created.body.id])
    const interrupted = store.findAgentRun(claimed.id)
    assert.equal(interrupted.status, 'queued')
    assert.match(interrupted.error, /рестартом воркера/)

    const reclaimed = store.claimNextAgentRun()
    assert.equal(reclaimed.taskId, created.body.id)
    assert.equal(reclaimed.error, '')
    assert.equal(reclaimed.finishedAt, null)
  })
})

test('рестарт worker не скасовує stop_revert і відновлює перерваний cleanup', async () => {
  await withTestApp(async ({ app, store }) => {
    const created = await request(app).post('/api/tasks').field('title', 'Відкладене очищення').expect(201)
    const claimed = store.claimNextAgentRun('worker-old')
    await request(app)
      .post(`/api/tasks/${created.body.id}/agent-runs/stop`)
      .send({ revert: true })
      .expect(200)

    assert.deepEqual(store.requeueOrphanedRuns(), [])
    const blocked = store.findAgentRun(claimed.id)
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.control, 'stop_revert')
    assert.equal(store.find(created.body.id).status, 'new')

    const cleanup = store.claimNextCleanupRun()
    assert.equal(cleanup.id, claimed.id)
    assert.equal(cleanup.control, 'cleanup_running')

    // Імітуємо ще один restart без finishCleanupRun.
    store.requeueOrphanedRuns()
    assert.equal(store.claimNextCleanupRun()?.id, claimed.id)
  })
})

test('резум не перебиває живий running-запуск', async () => {
  await withTestApp(async ({ app, store }) => {
    const created = await request(app).post('/api/tasks').field('title', 'Живе виконання').expect(201)
    const claimed = store.claimNextAgentRun('worker-live')
    assert.equal(claimed.status, 'running')

    const response = await request(app)
      .post(`/api/tasks/${created.body.id}/agent-runs/resume`)
      .expect(409)

    assert.match(response.body.message, /ще працює/i)
    assert.equal(store.findAgentRun(claimed.id).status, 'running')
  })
})

test('резум атомарно знімає лише протухлий running і ставить новий запуск', async () => {
  await withTestApp(async ({ app, store }) => {
    const created = await request(app).post('/api/tasks').field('title', 'Зависле виконання').expect(201)
    const claimed = store.claimNextAgentRun('worker-stale')
    store.database.prepare('UPDATE agent_runs SET heartbeat_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', claimed.id)

    const resumed = await request(app)
      .post(`/api/tasks/${created.body.id}/agent-runs/resume`)
      .expect(202)

    assert.equal(resumed.body.agentRun.status, 'queued')
    assert.equal(store.findAgentRun(claimed.id).status, 'failed')
  }, { agentRunStaleMs: 1000 })
})

test('lease допускає лише один живий Codex worker і дозволяє takeover після stale', async () => {
  await withTestApp(async ({ store }) => {
    const freshCutoff = new Date(Date.now() - 20_000).toISOString()
    assert.equal(store.acquireWorkerLease('codex-worker', 'worker-a', freshCutoff), true)
    assert.equal(store.acquireWorkerLease('codex-worker', 'worker-b', freshCutoff), false)
    assert.equal(store.heartbeatWorkerLease('codex-worker', 'worker-a'), true)

    store.database.prepare('UPDATE worker_leases SET heartbeat_at = ? WHERE name = ?')
      .run('2020-01-01T00:00:00.000Z', 'codex-worker')
    assert.equal(store.acquireWorkerLease('codex-worker', 'worker-b', freshCutoff), true)
    assert.equal(store.releaseWorkerLease('codex-worker', 'worker-a'), false)
    assert.equal(store.releaseWorkerLease('codex-worker', 'worker-b'), true)
  })
})

test('release-worker lease доступний лише внутрішньому процесу і серіалізує release queue', async () => {
  await withTestApp(async ({ app }) => {
    await request(app)
      .post('/api/system/worker-leases/release-worker/acquire')
      .send({ ownerId: 'worker-a', ttlMs: 20_000 })
      .expect(401)

    const internal = (requestBuilder) => requestBuilder.set('Authorization', 'Bearer test-internal-token')
    await internal(request(app).post('/api/system/worker-leases/release-worker/acquire'))
      .send({ ownerId: 'worker-a', ttlMs: 20_000 })
      .expect(200)
    await internal(request(app).post('/api/system/worker-leases/release-worker/acquire'))
      .send({ ownerId: 'worker-b', ttlMs: 20_000 })
      .expect(409)
    await internal(request(app).post('/api/system/worker-leases/release-worker/heartbeat'))
      .send({ ownerId: 'worker-a' })
      .expect(200)
    await internal(request(app).delete('/api/system/worker-leases/release-worker'))
      .send({ ownerId: 'worker-a' })
      .expect(200)
  }, { authRequired: true, secureCookies: false, internalApiToken: 'test-internal-token' })
})

test('release-state зберігається на run і лише released атомарно потрапляє у build', async () => {
  await withTestApp(async ({ app, store }) => {
    const created = await request(app).post('/api/tasks').field('title', 'Release state').expect(201)
    const runId = created.body.agentRun.id
    store.updateAgentRun(runId, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
    })
    const releaseOwner = 'release-test-worker'
    assert.equal(store.acquireWorkerLease('release-worker', releaseOwner, new Date(0).toISOString()), true)

    const processing = await request(app)
      .patch(`/api/agent-runs/${runId}/release`)
      .set('Authorization', 'Bearer test-internal-token')
      .send({
        status: 'processing',
        phase: 'verifying',
        leaseOwnerId: releaseOwner,
        attempts: 1,
        repositories: ['gba_console', 'gba_console'],
        evidence: {
          repositories: { gba_console: { commit: 'abc' } },
          deployment: { verifiedAt: new Date().toISOString(), services: { 'gba-console': { health: 'healthy' } } },
        },
      })
      .expect(200)
    assert.equal(processing.body.releaseStatus, 'processing')
    assert.equal(processing.body.releaseAttempts, 1)
    assert.deepEqual(processing.body.releaseRepositories, ['gba_console'])
    assert.equal(processing.body.releasePhase, 'verifying')
    assert.equal(processing.body.releaseEvidence.repositories.gba_console.commit, 'abc')
    assert.equal(store.currentBuild('__pending__'), null)

    await request(app)
      .post(`/api/tasks/${created.body.id}/agent-runs`)
      .expect(409)
    await request(app)
      .post(`/api/tasks/${created.body.id}/review-again`)
      .field('reviewComment', 'ще одна правка під час release')
      .expect(409)

    await request(app)
      .patch(`/api/agent-runs/${runId}/release`)
      .set('Authorization', 'Bearer test-internal-token')
      .send({ status: 'released', phase: 'released', leaseOwnerId: releaseOwner, taskStatus: 'ready_for_retest', releasedAt: new Date().toISOString() })
      .expect(200)

    assert.equal(store.find(created.body.id).status, 'ready_for_retest')
    const shipped = store.ensureBuild('release-test-build')
    assert.equal(shipped.bugs.length, 1)
    assert.equal(shipped.bugs[0].id, created.body.id)
    assert.equal(shipped.bugs[0].source, 'codex')
  })
})

test('фінальний release-state відхиляється без узгодженого taskStatus', async () => {
  await withTestApp(async ({ app, store }) => {
    const created = await request(app).post('/api/tasks').field('title', 'Release validation').expect(201)
    const releaseOwner = 'release-validation-worker'
    assert.equal(store.acquireWorkerLease('release-worker', releaseOwner, new Date(0).toISOString()), true)
    await request(app)
      .patch(`/api/agent-runs/${created.body.agentRun.id}/release`)
      .set('Authorization', 'Bearer test-internal-token')
      .send({ status: 'released', leaseOwnerId: releaseOwner })
      .expect(422)
    await request(app)
      .patch(`/api/agent-runs/${created.body.agentRun.id}/release`)
      .set('Authorization', 'Bearer test-internal-token')
      .send({ status: 'blocked', leaseOwnerId: releaseOwner, taskStatus: 'done' })
      .expect(422)
  })
})

test('закриту задачу не можна поставити у звичайну AI-чергу', async () => {
  await withTestApp(async ({ app, store }) => {
    const created = await request(app).post('/api/tasks').field('title', 'Closed task').expect(201)
    const activeRun = store.find(created.body.id).agentRun
    store.requestStop(created.body.id)
    await store.patch(created.body.id, { status: 'done' })

    const queued = store.enqueueAgentRun('RUN-CLOSED', created.body.id, 'manual')
    assert.equal(queued.status, 'task_done')
    assert.equal(queued.created, false)
    assert.equal(store.findAgentRun('RUN-CLOSED'), null)
    assert.equal(store.claimNextAgentRun(), null)

    await request(app)
      .post(`/api/tasks/${created.body.id}/agent-runs`)
      .expect(409, { message: 'Закриту задачу не запускаємо повторно. Спочатку відкрийте її на повторну перевірку.' })
    assert.equal(store.find(created.body.id).status, 'done')
    assert.equal(activeRun.id, created.body.agentRun.id)
  })
})

test('release pipeline може заблокуватися без автозміни людського статусу задачі', async () => {
  await withTestApp(async ({ app, store }) => {
    const created = await request(app).post('/api/tasks').field('title', 'Human retest').expect(201)
    const releaseOwner = 'release-human-status-worker'
    assert.equal(store.acquireWorkerLease('release-worker', releaseOwner, new Date(0).toISOString()), true)

    await request(app)
      .patch(`/api/agent-runs/${created.body.agentRun.id}/release`)
      .set('Authorization', 'Bearer test-internal-token')
      .send({ status: 'blocked', leaseOwnerId: releaseOwner, taskStatus: created.body.status })
      .expect(200)

    assert.equal(store.find(created.body.id).status, created.body.status)
  })
})

test('очищення worktree чекає, поки задача звільниться від активних прогонів', async () => {
  await withTestApp(async ({ app, store }) => {
    const created = await request(app).post('/api/tasks').field('title', 'Гонка відкату').expect(201)
    const first = store.claimNextAgentRun('worker-1')
    await request(app)
      .post(`/api/tasks/${created.body.id}/agent-runs/stop`)
      .send({ revert: true })
      .expect(200)
    // Воркер підтвердив зупинку: ран блокований і чекає на відкат worktree.
    store.updateAgentRun(first.id, { status: 'blocked', finishedAt: new Date().toISOString() })
    assert.equal(store.findAgentRun(first.id).control, 'stop_revert')

    // Нова спроба вже працює в ТІЙ САМІЙ теці worktree — саме так спроба 5
    // BUG-1003 лишилась без файлів, коли відкат старої спроби зніс каталог.
    store.enqueueAgentRun('RUN-RACE-2', created.body.id, 'manual')
    const second = store.claimNextAgentRun('worker-1')
    assert.equal(second.status, 'running')
    assert.equal(store.claimNextCleanupRun(), null, 'поки задача зайнята, прибирання не стартує')

    store.updateAgentRun(second.id, { status: 'completed', finishedAt: new Date().toISOString() })
    const cleanup = store.claimNextCleanupRun()
    assert.equal(cleanup?.id, first.id, 'після звільнення задачі прибирання відпрацьовує')
  })
})
