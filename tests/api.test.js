import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import request from 'supertest'
import { createApp } from '../server/app.js'
import { TaskStore, getSeedTasks } from '../server/store.js'
import { TranscriptionError, transcribeAudioWithShell } from '../server/transcription.js'

async function withTestApp(run, appOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'gba-bug-host-'))
  const dataDirectory = path.join(root, 'data')
  const uploadsDirectory = path.join(root, 'uploads')
  const store = new TaskStore(dataDirectory)

  try {
    const app = await createApp({ rootDirectory: root, dataDirectory, uploadsDirectory, store, ...appOptions })
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
      .field('area', 'Тестування')
      .field('priority', 'high')
      .field('status', 'new')
      .field('assignee', 'QA')
      .attach('attachments', tinyPng, { filename: 'proof.png', contentType: 'image/png' })
      .expect(201)

    assert.equal(created.body.id, 'BUG-1052')
    assert.equal(created.body.attachments.length, 1)
    assert.equal(created.body.attachments[0].kind, 'image')
    assert.equal(created.body.siteUrl, 'https://qa.example.com/orders/42')
    assert.equal(created.body.notes, 'POST /api/orders\nResponse: 500')
    assert.equal(created.body.agentRun.status, 'queued')
    assert.equal(created.body.agentRun.attempt, 1)
    assert.equal(
      existsSync(path.join(uploadsDirectory, path.basename(created.body.attachments[0].url))),
      true,
    )

    const updated = await request(app)
      .patch(`/api/tasks/${created.body.id}`)
      .send({ status: 'ready_for_retest' })
      .expect(200)

    assert.equal(updated.body.status, 'ready_for_retest')
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
    assert.equal(task.reviewComment, '')
    assert.equal(task.agentRun.reviewComment, '')
    assert.equal(task.agentRun.inputSnapshot, null)
    assert.equal(task.agentRun.workerId, '')
    assert.equal(task.agentRun.heartbeatAt, null)
    assert.equal(task.agentRun.releaseStatus, '')
    assert.equal(task.agentRun.releaseAttempts, 0)
    assert.deepEqual(task.agentRun.releaseRepositories, [])
    assert.equal(store.findAgentRun('RUN-LEGACY').contextSnapshot, '')
    assert.equal(store.findAgentRun('RUN-LEGACY').codexSessionId, '')

    const updated = store.patch('BUG-1001', {
      siteUrl: 'https://example.com/problem',
      notes: 'GET /api/products → 500',
      reviewComment: 'Кнопка все ще повертає 500.',
    })
    assert.equal(updated.siteUrl, 'https://example.com/problem')
    assert.equal(updated.notes, 'GET /api/products → 500')
    assert.equal(updated.reviewComment, 'Кнопка все ще повертає 500.')
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
    const firstApp = await createApp({ rootDirectory: root, dataDirectory, uploadsDirectory, store: firstStore })
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
      const secondApp = await createApp({ rootDirectory: root, dataDirectory, uploadsDirectory, store: secondStore })
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

test('API зупиняє чергову задачу і повертає її назад', async () => {
  await withTestApp(async ({ app, store }) => {
    const created = await request(app).post('/api/tasks').field('title', 'Задача для зупинки').expect(201)
    assert.equal(created.body.agentRun.status, 'queued')

    const stopped = await request(app)
      .post(`/api/tasks/${created.body.id}/agent-runs/stop`)
      .send({ revert: false })
      .expect(200)
    assert.equal(stopped.body.agentRun.status, 'blocked')
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
    assert.equal(store.findAgentRun(claimed.id).status, 'queued')
    assert.equal(store.claimNextAgentRun()?.taskId, created.body.id)
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

test('release-state зберігається на run і лише released атомарно потрапляє у build', async () => {
  await withTestApp(async ({ app, store }) => {
    const created = await request(app).post('/api/tasks').field('title', 'Release state').expect(201)
    const runId = created.body.agentRun.id
    store.updateAgentRun(runId, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
    })

    const processing = await request(app)
      .patch(`/api/agent-runs/${runId}/release`)
      .send({ status: 'processing', attempts: 1, repositories: ['gba_console', 'gba_console'] })
      .expect(200)
    assert.equal(processing.body.releaseStatus, 'processing')
    assert.equal(processing.body.releaseAttempts, 1)
    assert.deepEqual(processing.body.releaseRepositories, ['gba_console'])
    assert.equal(store.currentBuild('__pending__'), null)

    await request(app)
      .patch(`/api/agent-runs/${runId}/release`)
      .send({ status: 'released', taskStatus: 'ready_for_retest', releasedAt: new Date().toISOString() })
      .expect(200)

    assert.equal(store.find(created.body.id).status, 'ready_for_retest')
    const shipped = store.ensureBuild('release-test-build')
    assert.equal(shipped.bugs.length, 1)
    assert.equal(shipped.bugs[0].id, created.body.id)
    assert.equal(shipped.bugs[0].source, 'codex')
  })
})

test('фінальний release-state відхиляється без узгодженого taskStatus', async () => {
  await withTestApp(async ({ app }) => {
    const created = await request(app).post('/api/tasks').field('title', 'Release validation').expect(201)
    await request(app)
      .patch(`/api/agent-runs/${created.body.agentRun.id}/release`)
      .send({ status: 'released' })
      .expect(422)
    await request(app)
      .patch(`/api/agent-runs/${created.body.agentRun.id}/release`)
      .send({ status: 'blocked', taskStatus: 'done' })
      .expect(422)
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
