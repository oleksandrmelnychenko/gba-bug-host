import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const seedTasks = [
  {
    id: 'BUG-1051',
    title: 'Пошук падає після очищення поля',
    description: 'Якщо стерти всі символи в пошуку, сторінка перестає відповідати й показує білий екран.',
    siteUrl: '',
    notes: '',
    area: 'Пошук',
    status: 'new',
    priority: 'critical',
    assignee: 'Не призначено',
    createdAt: '2026-08-06T08:40:00.000Z',
    updatedAt: '2026-08-06T08:40:00.000Z',
    attachments: [],
  },
  {
    id: 'BUG-1050',
    title: 'Новий клієнт не може увійти в магазин',
    description: 'Після успішної реєстрації нового клієнта форма входу повертає помилку авторизації.',
    siteUrl: '',
    notes: '',
    area: 'Авторизація',
    status: 'in_progress',
    priority: 'high',
    assignee: 'Олександр',
    createdAt: '2026-08-05T12:15:00.000Z',
    updatedAt: '2026-08-06T07:20:00.000Z',
    attachments: [],
  },
  {
    id: 'BUG-1049',
    title: 'Недоступний товар показується в наявності',
    description: 'Картка товару має статус «В наявності», але додати товар у кошик неможливо.',
    siteUrl: '',
    notes: '',
    area: 'Продаж',
    status: 'ready_for_retest',
    priority: 'high',
    assignee: 'Андрій',
    createdAt: '2026-08-04T09:10:00.000Z',
    updatedAt: '2026-08-05T16:45:00.000Z',
    attachments: [],
  },
  {
    id: 'BUG-1048',
    title: 'Кількості товару не збігаються',
    description: 'Залишок на складі відрізняється від кількості, яку бачить покупець в інтернет-магазині.',
    siteUrl: '',
    notes: '',
    area: 'Товари',
    status: 'blocked',
    priority: 'medium',
    assignee: 'Марія',
    createdAt: '2026-08-03T14:30:00.000Z',
    updatedAt: '2026-08-05T10:00:00.000Z',
    attachments: [],
  },
  {
    id: 'BUG-1047',
    title: 'Помилка під час реєстрації покупця',
    description: 'Валідація номера телефону блокує коректний український номер.',
    siteUrl: '',
    notes: '',
    area: 'Реєстрація',
    status: 'done',
    priority: 'medium',
    assignee: 'Ірина',
    createdAt: '2026-08-01T11:05:00.000Z',
    updatedAt: '2026-08-04T15:30:00.000Z',
    attachments: [],
  },
]

function agentRunFromRow(row) {
  if (!row) return null
  return {
    id: row.id,
    taskId: row.task_id,
    trigger: row.trigger,
    status: row.status,
    attempt: row.attempt,
    branch: row.branch,
    worktreePath: row.worktree_path,
    summary: row.summary,
    details: row.details,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  }
}

function taskFromRow(row, attachments = [], agentRun = null) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    siteUrl: row.site_url ?? '',
    notes: row.notes ?? '',
    area: row.area,
    status: row.status,
    priority: row.priority,
    assignee: row.assignee,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments,
    agentRun,
  }
}

function attachmentFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    type: row.type,
    size: row.size,
    kind: row.kind,
  }
}

export class TaskStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory
    this.databasePath = path.join(dataDirectory, 'gba-qa.sqlite')
    this.legacyJsonPath = path.join(dataDirectory, 'tasks.json')
    this.database = null
  }

  async ensureReady() {
    if (this.database) return

    await mkdir(this.dataDirectory, { recursive: true })
    this.database = new DatabaseSync(this.databasePath)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        site_url TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        area TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        assignee TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'video'))
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'review_again')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'needs_review', 'blocked', 'failed')),
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
      CREATE TABLE IF NOT EXISTS builds (
        number TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS build_tasks (
        build_number TEXT NOT NULL REFERENCES builds(number) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        processed_at TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('manual', 'codex')),
        task_status TEXT NOT NULL,
        PRIMARY KEY (build_number, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_task_id ON attachments(task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_task_id ON agent_runs(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_queue ON agent_runs(status, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_active_task
        ON agent_runs(task_id) WHERE status IN ('queued', 'running');
      CREATE INDEX IF NOT EXISTS idx_build_tasks_processed_at ON build_tasks(build_number, processed_at DESC);
    `)

    const taskColumns = new Set(
      this.database.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name),
    )
    if (!taskColumns.has('site_url')) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN site_url TEXT NOT NULL DEFAULT ''")
    }
    if (!taskColumns.has('notes')) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN notes TEXT NOT NULL DEFAULT ''")
    }

    const { total } = this.database.prepare('SELECT COUNT(*) AS total FROM tasks').get()
    if (total === 0) {
      const initialTasks = await this.readLegacyTasks()
      this.transaction(() => {
        for (const task of initialTasks) this.insertTask(task)
      })
    }
  }

  async readLegacyTasks() {
    try {
      const tasks = JSON.parse(await readFile(this.legacyJsonPath, 'utf8'))
      if (Array.isArray(tasks) && tasks.length > 0) {
        return tasks.map((task) => ({
          ...task,
          siteUrl: task.siteUrl ?? '',
          notes: task.notes ?? '',
          attachments: (task.attachments ?? []).map((attachment) => ({
            ...attachment,
            kind: attachment.kind ?? (attachment.type?.startsWith('video/') ? 'video' : 'image'),
          })),
        }))
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    return seedTasks
  }

  transaction(callback) {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  insertTask(task) {
    this.database.prepare(`
      INSERT INTO tasks (id, title, description, site_url, notes, area, status, priority, assignee, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.title,
      task.description,
      task.siteUrl ?? '',
      task.notes ?? '',
      task.area,
      task.status,
      task.priority,
      task.assignee,
      task.createdAt,
      task.updatedAt,
    )

    for (const attachment of task.attachments ?? []) {
      this.insertAttachment(task.id, attachment)
    }
  }

  insertAttachment(taskId, attachment) {
    this.database.prepare(`
      INSERT INTO attachments (id, task_id, name, url, type, size, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      attachment.id,
      taskId,
      attachment.name,
      attachment.url,
      attachment.type,
      attachment.size,
      attachment.kind,
    )
  }

  all() {
    const taskRows = this.database.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all()
    const attachmentRows = this.database.prepare('SELECT * FROM attachments').all()
    const agentRunRows = this.database.prepare('SELECT * FROM agent_runs ORDER BY created_at DESC').all()
    const attachmentsByTask = new Map()
    const latestAgentRunByTask = new Map()

    for (const row of attachmentRows) {
      const attachments = attachmentsByTask.get(row.task_id) ?? []
      attachments.push(attachmentFromRow(row))
      attachmentsByTask.set(row.task_id, attachments)
    }

    for (const row of agentRunRows) {
      if (!latestAgentRunByTask.has(row.task_id)) {
        latestAgentRunByTask.set(row.task_id, agentRunFromRow(row))
      }
    }

    return taskRows.map((row) => taskFromRow(
      row,
      attachmentsByTask.get(row.id) ?? [],
      latestAgentRunByTask.get(row.id) ?? null,
    ))
  }

  find(id) {
    const row = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    if (!row) return null
    const attachments = this.database
      .prepare('SELECT * FROM attachments WHERE task_id = ?')
      .all(id)
      .map(attachmentFromRow)
    const agentRun = agentRunFromRow(
      this.database.prepare('SELECT * FROM agent_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(id),
    )
    return taskFromRow(row, attachments, agentRun)
  }

  create(values, attachments) {
    const { maximum } = this.database
      .prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id, 5) AS INTEGER)), 1000) AS maximum FROM tasks")
      .get()
    const now = new Date().toISOString()
    const task = {
      id: `BUG-${Number(maximum) + 1}`,
      ...values,
      createdAt: now,
      updatedAt: now,
      attachments,
    }
    this.transaction(() => this.insertTask(task))
    return task
  }

  patch(id, values) {
    const existingTask = this.find(id)
    if (!existingTask) return null

    const allowedFields = ['title', 'description', 'siteUrl', 'notes', 'area', 'status', 'priority', 'assignee']
    const fields = allowedFields.filter((field) => Object.hasOwn(values, field))
    const updatedAt = new Date().toISOString()

    if (fields.length > 0) {
      const columnNames = {
        title: 'title',
        description: 'description',
        siteUrl: 'site_url',
        notes: 'notes',
        area: 'area',
        status: 'status',
        priority: 'priority',
        assignee: 'assignee',
      }
      const assignments = fields.map((field) => `${columnNames[field]} = ?`).join(', ')
      this.database
        .prepare(`UPDATE tasks SET ${assignments}, updated_at = ? WHERE id = ?`)
        .run(...fields.map((field) => values[field]), updatedAt, id)
    }

    return this.find(id)
  }

  addAttachments(id, attachments) {
    if (!this.find(id)) return null
    const updatedAt = new Date().toISOString()
    this.transaction(() => {
      for (const attachment of attachments) this.insertAttachment(id, attachment)
      this.database.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(updatedAt, id)
    })
    return this.find(id)
  }

  removeAttachment(taskId, attachmentId) {
    if (!this.find(taskId)) return { status: 'task_not_found' }
    const row = this.database
      .prepare('SELECT * FROM attachments WHERE id = ? AND task_id = ?')
      .get(attachmentId, taskId)
    if (!row) return { status: 'attachment_not_found' }

    this.transaction(() => {
      this.database.prepare('DELETE FROM attachments WHERE id = ?').run(attachmentId)
      this.database
        .prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), taskId)
    })

    return {
      status: 'removed',
      attachment: attachmentFromRow(row),
      task: this.find(taskId),
    }
  }

  enqueueAgentRun(id, taskId, trigger = 'manual') {
    if (!this.find(taskId)) return { status: 'task_not_found', run: null, created: false }

    const activeRow = this.database
      .prepare("SELECT * FROM agent_runs WHERE task_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1")
      .get(taskId)
    if (activeRow) return { status: 'active', run: agentRunFromRow(activeRow), created: false }

    const { nextAttempt } = this.database
      .prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS nextAttempt FROM agent_runs WHERE task_id = ?')
      .get(taskId)
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT INTO agent_runs (
        id, task_id, trigger, status, attempt, branch, worktree_path,
        summary, details, error, created_at, started_at, finished_at, updated_at
      ) VALUES (?, ?, ?, 'queued', ?, '', '', '', '', '', ?, NULL, NULL, ?)
    `).run(id, taskId, trigger, nextAttempt, now, now)

    return { status: 'queued', run: this.findAgentRun(id), created: true }
  }

  findAgentRun(id) {
    return agentRunFromRow(this.database.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id))
  }

  agentRunsForTask(taskId) {
    return this.database
      .prepare('SELECT * FROM agent_runs WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId)
      .map(agentRunFromRow)
  }

  claimNextAgentRun() {
    return this.transaction(() => {
      const row = this.database
        .prepare("SELECT * FROM agent_runs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
        .get()
      if (!row) return null

      const now = new Date().toISOString()
      const result = this.database
        .prepare("UPDATE agent_runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
        .run(now, now, row.id)
      return result.changes === 1 ? this.findAgentRun(row.id) : null
    })
  }

  updateAgentRun(id, values) {
    const allowedFields = ['status', 'branch', 'worktreePath', 'summary', 'details', 'error', 'finishedAt']
    const fields = allowedFields.filter((field) => Object.hasOwn(values, field))
    if (!fields.length) return this.findAgentRun(id)

    const columnNames = {
      status: 'status',
      branch: 'branch',
      worktreePath: 'worktree_path',
      summary: 'summary',
      details: 'details',
      error: 'error',
      finishedAt: 'finished_at',
    }
    const assignments = fields.map((field) => `${columnNames[field]} = ?`).join(', ')
    this.database
      .prepare(`UPDATE agent_runs SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...fields.map((field) => values[field]), new Date().toISOString(), id)
    return this.findAgentRun(id)
  }

  recoverInterruptedAgentRuns(olderThan = new Date(0).toISOString()) {
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE agent_runs
      SET status = 'failed', error = 'Worker було перезапущено під час виконання.', finished_at = ?, updated_at = ?
      WHERE status = 'running' AND updated_at < ?
    `).run(now, now, olderThan)
  }

  ensureBuild(buildNumber) {
    const number = String(buildNumber).trim()
    if (!number) throw new Error('Номер build не може бути порожнім.')
    this.database
      .prepare('INSERT OR IGNORE INTO builds (number, created_at) VALUES (?, ?)')
      .run(number, new Date().toISOString())
    return this.currentBuild(number)
  }

  markTaskProcessed(buildNumber, taskId, source = 'manual') {
    const task = this.find(taskId)
    if (!task) return null
    const number = String(buildNumber).trim()
    this.database
      .prepare('INSERT OR IGNORE INTO builds (number, created_at) VALUES (?, ?)')
      .run(number, new Date().toISOString())
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT INTO build_tasks (build_number, task_id, processed_at, source, task_status)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(build_number, task_id) DO UPDATE SET
        processed_at = excluded.processed_at,
        source = excluded.source,
        task_status = excluded.task_status
    `).run(number, taskId, now, source, task.status)
    return this.currentBuild(number)
  }

  currentBuild(buildNumber) {
    const number = String(buildNumber).trim()
    const build = this.database.prepare('SELECT * FROM builds WHERE number = ?').get(number)
    if (!build) return null
    const bugs = this.database.prepare(`
      SELECT
        tasks.id,
        tasks.title,
        tasks.status,
        tasks.priority,
        tasks.area,
        build_tasks.processed_at,
        build_tasks.source,
        build_tasks.task_status
      FROM build_tasks
      JOIN tasks ON tasks.id = build_tasks.task_id
      WHERE build_tasks.build_number = ?
      ORDER BY build_tasks.processed_at DESC
    `).all(number)
    return {
      number: build.number,
      createdAt: build.created_at,
      bugs: bugs.map((bug) => ({
        id: bug.id,
        title: bug.title,
        status: bug.status,
        statusAtProcessing: bug.task_status,
        priority: bug.priority,
        area: bug.area,
        processedAt: bug.processed_at,
        source: bug.source,
      })),
    }
  }

  delete(id) {
    const task = this.find(id)
    if (!task) return null
    this.database.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    return task
  }

  close() {
    this.database?.close()
    this.database = null
  }
}

export function getSeedTasks() {
  return structuredClone(seedTasks)
}
