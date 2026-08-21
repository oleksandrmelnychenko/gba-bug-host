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

const PENDING_BUILD = '__pending__'

function mapBuildTask(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    statusAtProcessing: row.task_status,
    priority: row.priority,
    area: row.area,
    processedAt: row.processed_at,
    source: row.source,
  }
}

function agentRunFromRow(row, { includeWorkerContext = false } = {}) {
  if (!row) return null
  let inputSnapshot = null
  try {
    const parsed = JSON.parse(row.input_snapshot ?? 'null')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
      inputSnapshot = parsed
    }
  } catch {
    inputSnapshot = null
  }
  let releaseRepositories = []
  try {
    const parsed = JSON.parse(row.release_repositories ?? '[]')
    if (Array.isArray(parsed)) releaseRepositories = parsed.filter((item) => typeof item === 'string')
  } catch {
    releaseRepositories = []
  }
  let releaseEvidence = {}
  try {
    const parsed = JSON.parse(row.release_evidence ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) releaseEvidence = parsed
  } catch {
    releaseEvidence = {}
  }
  return {
    id: row.id,
    taskId: row.task_id,
    trigger: row.trigger,
    status: row.status,
    attempt: row.attempt,
    reviewComment: row.review_comment || inputSnapshot?.reviewComment || '',
    inputSnapshot,
    queuePriority: row.queue_priority ?? 0,
    control: row.control ?? '',
    branch: row.branch,
    worktreePath: row.worktree_path,
    summary: row.summary,
    details: row.details,
    error: row.error,
    workerId: row.worker_id ?? '',
    heartbeatAt: row.heartbeat_at ?? null,
    releaseStatus: row.release_status ?? '',
    releaseAttempts: row.release_attempts ?? 0,
    releaseRepositories,
    releaseError: row.release_error ?? '',
    releasePhase: row.release_phase ?? '',
    releaseEvidence,
    releasedAt: row.released_at ?? null,
    ...(includeWorkerContext ? {
      contextSnapshot: row.context_snapshot ?? '',
      codexSessionId: row.codex_session_id ?? '',
    } : {}),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  }
}

function agentRunInputFromTask(task) {
  return {
    title: task.title,
    description: task.description ?? '',
    siteUrl: task.siteUrl ?? '',
    notes: task.notes ?? '',
    reviewComment: task.reviewComment ?? '',
    area: task.area,
    project: task.project ?? 'console',
    status: task.status,
    priority: task.priority,
    attachments: (task.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      url: attachment.url,
      type: attachment.type,
      size: attachment.size,
      kind: attachment.kind,
    })),
  }
}

function taskFromRow(row, attachments = [], agentRun = null) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    siteUrl: row.site_url ?? '',
    notes: row.notes ?? '',
    staffComments: row.staff_comments ?? '',
    reviewComment: row.review_comment ?? '',
    area: row.area,
    project: row.project ?? 'console',
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

function commentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    parentId: row.parent_id ?? null,
    authorUserId: row.author_user_id ?? null,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        site_url TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        staff_comments TEXT NOT NULL DEFAULT '',
        review_comment TEXT NOT NULL DEFAULT '',
        area TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        assignee TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
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
        kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'document'))
      );
      CREATE TABLE IF NOT EXISTS task_comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES task_comments(id) ON DELETE RESTRICT,
        author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'review_again')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'needs_review', 'blocked', 'failed')),
        attempt INTEGER NOT NULL,
        review_comment TEXT NOT NULL DEFAULT '',
        input_snapshot TEXT NOT NULL DEFAULT '{}',
        queue_priority INTEGER NOT NULL DEFAULT 0,
        control TEXT NOT NULL DEFAULT '',
        branch TEXT NOT NULL DEFAULT '',
        worktree_path TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        details TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        worker_id TEXT NOT NULL DEFAULT '',
        heartbeat_at TEXT,
        release_status TEXT NOT NULL DEFAULT 'pending',
        release_attempts INTEGER NOT NULL DEFAULT 0,
        release_repositories TEXT NOT NULL DEFAULT '[]',
        release_error TEXT NOT NULL DEFAULT '',
        release_phase TEXT NOT NULL DEFAULT '',
        release_evidence TEXT NOT NULL DEFAULT '{}',
        released_at TEXT,
        context_snapshot TEXT NOT NULL DEFAULT '',
        codex_session_id TEXT NOT NULL DEFAULT '',
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
      CREATE TABLE IF NOT EXISTS system_state (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_leases (
        name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_comment_reads (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        comment_id TEXT NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
        read_at TEXT NOT NULL,
        PRIMARY KEY (user_id, comment_id)
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_task_id ON attachments(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_comments_task_created ON task_comments(task_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_task_comments_parent ON task_comments(parent_id);
      CREATE INDEX IF NOT EXISTS idx_task_comments_author ON task_comments(author_user_id);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_task_comment_reads_comment ON task_comment_reads(comment_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_task_id ON agent_runs(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_queue ON agent_runs(status, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_active_task
        ON agent_runs(task_id) WHERE status IN ('queued', 'running');
      CREATE INDEX IF NOT EXISTS idx_build_tasks_processed_at ON build_tasks(build_number, processed_at DESC);
    `)

    this.transaction(() => {
      const attachmentTableSql = this.database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attachments'")
        .get()?.sql ?? ''
      if (!attachmentTableSql.includes("'document'")) {
        this.database.exec(`
          ALTER TABLE attachments RENAME TO attachments_before_document_support;
          CREATE TABLE attachments (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            type TEXT NOT NULL,
            size INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'document'))
          );
          INSERT INTO attachments (id, task_id, name, url, type, size, kind)
          SELECT id, task_id, name, url, type, size, kind
          FROM attachments_before_document_support;
          DROP TABLE attachments_before_document_support;
          CREATE INDEX IF NOT EXISTS idx_attachments_task_id ON attachments(task_id);
        `)
      }

      const taskColumns = new Set(
        this.database.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name),
      )
      if (!taskColumns.has('site_url')) {
        this.database.exec("ALTER TABLE tasks ADD COLUMN site_url TEXT NOT NULL DEFAULT ''")
      }
      if (!taskColumns.has('notes')) {
        this.database.exec("ALTER TABLE tasks ADD COLUMN notes TEXT NOT NULL DEFAULT ''")
      }
      if (!taskColumns.has('staff_comments')) {
        this.database.exec("ALTER TABLE tasks ADD COLUMN staff_comments TEXT NOT NULL DEFAULT ''")
      }
      if (!taskColumns.has('review_comment')) {
        this.database.exec("ALTER TABLE tasks ADD COLUMN review_comment TEXT NOT NULL DEFAULT ''")
      }
      if (!taskColumns.has('project')) {
        this.database.exec("ALTER TABLE tasks ADD COLUMN project TEXT NOT NULL DEFAULT 'console'")
      }

      const commentColumns = new Set(
        this.database.prepare('PRAGMA table_info(task_comments)').all().map((column) => column.name),
      )
      if (!commentColumns.has('author_user_id')) {
        this.database.exec('ALTER TABLE task_comments ADD COLUMN author_user_id TEXT')
      }

      this.database.exec(`
        INSERT INTO task_comments (id, task_id, parent_id, author_user_id, author, body, created_at, updated_at)
        SELECT 'legacy-staff:' || id, id, NULL, NULL, 'Команда (імпорт)', TRIM(staff_comments), updated_at, updated_at
        FROM tasks
        WHERE TRIM(staff_comments) <> ''
        ON CONFLICT(id) DO NOTHING
      `)

      const agentRunColumns = new Set(
        this.database.prepare('PRAGMA table_info(agent_runs)').all().map((column) => column.name),
      )
      if (!agentRunColumns.has('review_comment')) {
        this.database.exec("ALTER TABLE agent_runs ADD COLUMN review_comment TEXT NOT NULL DEFAULT ''")
      }
      if (!agentRunColumns.has('input_snapshot')) {
        this.database.exec("ALTER TABLE agent_runs ADD COLUMN input_snapshot TEXT NOT NULL DEFAULT '{}'")
      }
      if (!agentRunColumns.has('queue_priority')) {
        this.database.exec('ALTER TABLE agent_runs ADD COLUMN queue_priority INTEGER NOT NULL DEFAULT 0')
      }
      if (!agentRunColumns.has('control')) {
        // stop | stop_revert — керуюча команда оператора для активного рану.
        this.database.exec("ALTER TABLE agent_runs ADD COLUMN control TEXT NOT NULL DEFAULT ''")
      }
      if (!agentRunColumns.has('worker_id')) {
        this.database.exec("ALTER TABLE agent_runs ADD COLUMN worker_id TEXT NOT NULL DEFAULT ''")
      }
      if (!agentRunColumns.has('heartbeat_at')) {
        this.database.exec('ALTER TABLE agent_runs ADD COLUMN heartbeat_at TEXT')
      }
      if (!agentRunColumns.has('release_status')) {
        // Порожній статус означає legacy-run: до першого нового release він
        // продовжує використовувати старий marker у notes.
        this.database.exec("ALTER TABLE agent_runs ADD COLUMN release_status TEXT NOT NULL DEFAULT ''")
      }
      if (!agentRunColumns.has('release_attempts')) {
        this.database.exec('ALTER TABLE agent_runs ADD COLUMN release_attempts INTEGER NOT NULL DEFAULT 0')
      }
      if (!agentRunColumns.has('release_repositories')) {
        this.database.exec("ALTER TABLE agent_runs ADD COLUMN release_repositories TEXT NOT NULL DEFAULT '[]'")
      }
      if (!agentRunColumns.has('release_error')) {
        this.database.exec("ALTER TABLE agent_runs ADD COLUMN release_error TEXT NOT NULL DEFAULT ''")
      }
      if (!agentRunColumns.has('release_phase')) {
        this.database.exec("ALTER TABLE agent_runs ADD COLUMN release_phase TEXT NOT NULL DEFAULT ''")
      }
      if (!agentRunColumns.has('release_evidence')) {
        this.database.exec("ALTER TABLE agent_runs ADD COLUMN release_evidence TEXT NOT NULL DEFAULT '{}'")
      }
      if (!agentRunColumns.has('released_at')) {
        this.database.exec('ALTER TABLE agent_runs ADD COLUMN released_at TEXT')
      }
      if (!agentRunColumns.has('context_snapshot')) {
        this.database.exec("ALTER TABLE agent_runs ADD COLUMN context_snapshot TEXT NOT NULL DEFAULT ''")
      }
      if (!agentRunColumns.has('codex_session_id')) {
        this.database.exec("ALTER TABLE agent_runs ADD COLUMN codex_session_id TEXT NOT NULL DEFAULT ''")
      }
      this.database.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_heartbeat ON agent_runs(status, heartbeat_at)')
    })

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
          staffComments: task.staffComments ?? '',
          reviewComment: task.reviewComment ?? '',
          attachments: (task.attachments ?? []).map((attachment) => ({
            ...attachment,
            kind: attachment.kind ?? (attachment.type?.startsWith('video/') ? 'video' : 'image'),
          })),
        }))
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    return []
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
      INSERT INTO tasks (id, title, description, site_url, notes, staff_comments, review_comment, area, project, status, priority, assignee, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.title,
      task.description,
      task.siteUrl ?? '',
      task.notes ?? '',
      task.staffComments ?? '',
      task.reviewComment ?? '',
      task.area,
      task.project ?? 'console',
      task.status,
      task.priority,
      task.assignee,
      task.createdAt,
      task.updatedAt,
    )

    for (const attachment of task.attachments ?? []) {
      this.insertAttachment(task.id, attachment)
    }

    const initialComment = (task.staffComments ?? '').trim()
    if (initialComment) {
      this.insertComment({
        id: `legacy-staff:${task.id}`,
        taskId: task.id,
        parentId: null,
        authorUserId: task.staffCommentAuthorUserId ?? null,
        author: task.staffCommentAuthor ?? 'Команда',
        body: initialComment,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })
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

  insertComment(comment) {
    this.database.prepare(`
      INSERT INTO task_comments (id, task_id, parent_id, author_user_id, author, body, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      comment.id,
      comment.taskId,
      comment.parentId ?? null,
      comment.authorUserId ?? null,
      comment.author,
      comment.body,
      comment.createdAt,
      comment.updatedAt,
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

  commentsForTask(taskId) {
    return this.database
      .prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at, id')
      .all(taskId)
      .map(commentFromRow)
  }

  addTaskComment(id, taskId, values) {
    if (!this.database.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) {
      return { status: 'task_not_found', comment: null }
    }

    if (values.parentId) {
      const parent = this.database
        .prepare('SELECT task_id FROM task_comments WHERE id = ?')
        .get(values.parentId)
      if (!parent || parent.task_id !== taskId) {
        return { status: 'parent_not_found', comment: null }
      }
    }

    const now = new Date().toISOString()
    const comment = {
      id,
      taskId,
      parentId: values.parentId || null,
      authorUserId: values.authorUserId ?? null,
      author: values.author,
      body: values.body,
      createdAt: now,
      updatedAt: now,
    }
    this.transaction(() => this.insertComment(comment))
    return { status: 'created', comment }
  }

  unreadCommentsForUser(userId, limit = 20) {
    const rows = this.database.prepare(`
      SELECT task_comments.*, tasks.title AS task_title
      FROM task_comments
      JOIN tasks ON tasks.id = task_comments.task_id
      WHERE (task_comments.author_user_id IS NULL OR task_comments.author_user_id <> ?)
        AND NOT EXISTS (
          SELECT 1 FROM task_comment_reads
          WHERE task_comment_reads.user_id = ?
            AND task_comment_reads.comment_id = task_comments.id
        )
      ORDER BY task_comments.created_at DESC, task_comments.id DESC
      LIMIT ?
    `).all(userId, userId, limit)
    const { total } = this.database.prepare(`
      SELECT COUNT(*) AS total
      FROM task_comments
      WHERE (author_user_id IS NULL OR author_user_id <> ?)
        AND NOT EXISTS (
          SELECT 1 FROM task_comment_reads
          WHERE task_comment_reads.user_id = ?
            AND task_comment_reads.comment_id = task_comments.id
        )
    `).get(userId, userId)
    return {
      total,
      comments: rows.map((row) => ({ ...commentFromRow(row), taskTitle: row.task_title })),
    }
  }

  markTaskCommentsRead(userId, taskId) {
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT OR IGNORE INTO task_comment_reads (user_id, comment_id, read_at)
      SELECT ?, id, ?
      FROM task_comments
      WHERE task_id = ?
        AND (author_user_id IS NULL OR author_user_id <> ?)
    `).run(userId, now, taskId, userId)
    return this.unreadCommentsForUser(userId)
  }

  markAllCommentsRead(userId) {
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT OR IGNORE INTO task_comment_reads (user_id, comment_id, read_at)
      SELECT ?, id, ? FROM task_comments
      WHERE author_user_id IS NULL OR author_user_id <> ?
    `).run(userId, now, userId)
  }

  upsertUser(user) {
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT INTO users (id, email, display_name, password_hash, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        display_name = excluded.display_name,
        password_hash = excluded.password_hash,
        active = 1,
        updated_at = excluded.updated_at
    `).run(user.id, user.email.toLowerCase(), user.displayName, user.passwordHash, now, now)
    return this.findUserByEmail(user.email)
  }

  findUserByEmail(email) {
    const row = this.database.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email)
    if (!row) return null
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      passwordHash: row.password_hash,
      active: row.active === 1,
    }
  }

  createSession(tokenHash, userId, expiresAt) {
    const now = new Date().toISOString()
    this.transaction(() => {
      this.database.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now)
      this.database.prepare(`
        INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(tokenHash, userId, now, expiresAt)
    })
  }

  findSession(tokenHash) {
    const row = this.database.prepare(`
      SELECT users.id, users.email, users.display_name
      FROM auth_sessions
      JOIN users ON users.id = auth_sessions.user_id
      WHERE auth_sessions.token_hash = ?
        AND auth_sessions.expires_at > ?
        AND users.active = 1
    `).get(tokenHash, new Date().toISOString())
    if (!row) return null
    return { id: row.id, email: row.email, displayName: row.display_name }
  }

  deleteSession(tokenHash) {
    this.database.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash)
  }

  deleteSessionsForUser(userId) {
    this.database.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId)
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

    const allowedFields = ['title', 'description', 'siteUrl', 'notes', 'staffComments', 'reviewComment', 'area', 'project', 'status', 'priority', 'assignee']
    const fields = allowedFields.filter((field) => Object.hasOwn(values, field))
    const updatedAt = new Date().toISOString()

    if (fields.length > 0) {
      const columnNames = {
        title: 'title',
        description: 'description',
        siteUrl: 'site_url',
        notes: 'notes',
        staffComments: 'staff_comments',
        reviewComment: 'review_comment',
        area: 'area',
        project: 'project',
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

  reviewAgain(runId, taskId, values, attachments = []) {
    return this.transaction(() => {
      const existingTask = this.find(taskId)
      if (!existingTask) return { status: 'task_not_found', task: null, run: null }
      if (this.hasActiveRelease(taskId)) {
        return { status: 'release_active', task: existingTask, run: existingTask.agentRun }
      }
      if (existingTask.status === 'review_again') {
        return { status: 'already_reviewing', task: existingTask, run: existingTask.agentRun }
      }

      const activeRun = this.database
        .prepare("SELECT * FROM agent_runs WHERE task_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1")
        .get(taskId)
      if (activeRun) {
        return { status: 'active', task: existingTask, run: agentRunFromRow(activeRun) }
      }

      this.patch(taskId, { ...values, status: 'review_again' })
      for (const attachment of attachments) this.insertAttachment(taskId, attachment)

      const queued = this.enqueueAgentRun(runId, taskId, 'review_again')
      if (!queued.created) throw new Error(`Failed to enqueue review run: ${queued.status}`)
      return { status: 'queued', task: this.find(taskId), run: queued.run }
    })
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
    const task = this.find(taskId)
    if (!task) return { status: 'task_not_found', run: null, created: false }
    if (this.hasActiveRelease(taskId)) {
      return { status: 'release_active', run: task.agentRun, created: false }
    }

    const activeRow = this.database
      .prepare("SELECT * FROM agent_runs WHERE task_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1")
      .get(taskId)
    if (activeRow) return { status: 'active', run: agentRunFromRow(activeRow), created: false }

    const { nextAttempt } = this.database
      .prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS nextAttempt FROM agent_runs WHERE task_id = ?')
      .get(taskId)
    const now = new Date().toISOString()
    const inputSnapshot = agentRunInputFromTask(task)
    const previousSession = this.database
      .prepare(`
        SELECT codex_session_id FROM agent_runs
        WHERE task_id = ? AND codex_session_id <> ''
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(taskId)
    this.database.prepare(`
      INSERT INTO agent_runs (
        id, task_id, trigger, status, attempt, review_comment, input_snapshot, branch, worktree_path,
        summary, details, error, release_status, context_snapshot, codex_session_id,
        created_at, started_at, finished_at, updated_at
      ) VALUES (?, ?, ?, 'queued', ?, ?, ?, '', '', '', '', '', 'pending', '', ?, ?, NULL, NULL, ?)
    `).run(
      id,
      taskId,
      trigger,
      nextAttempt,
      task.reviewComment ?? '',
      JSON.stringify(inputSnapshot),
      previousSession?.codex_session_id ?? '',
      now,
      now,
    )

    return { status: 'queued', run: this.findAgentRun(id), created: true }
  }

  findAgentRun(id) {
    return agentRunFromRow(
      this.database.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id),
      { includeWorkerContext: true },
    )
  }

  agentRunsForTask(taskId) {
    return this.database
      .prepare('SELECT * FROM agent_runs WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId)
      .map(agentRunFromRow)
  }

  releasedContextForProject(project, limit = 20, releasedSince = '') {
    const normalizedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 20
    return this.database.prepare(`
      SELECT
        r.id AS run_id,
        r.task_id,
        r.summary,
        r.details,
        r.released_at,
        t.title,
        t.area
      FROM agent_runs AS r
      JOIN tasks AS t ON t.id = r.task_id
      WHERE t.project = ?
        AND r.release_status = 'released'
        AND (? = '' OR COALESCE(r.released_at, r.finished_at, r.updated_at) >= ?)
        AND r.id = (
          SELECT latest.id
          FROM agent_runs AS latest
          WHERE latest.task_id = r.task_id AND latest.release_status = 'released'
          ORDER BY COALESCE(latest.released_at, latest.finished_at, latest.updated_at) DESC
          LIMIT 1
        )
      ORDER BY COALESCE(r.released_at, r.finished_at, r.updated_at) DESC
      LIMIT ?
    `).all(project, releasedSince, releasedSince, normalizedLimit).map((row) => ({
      runId: row.run_id,
      taskId: row.task_id,
      title: row.title,
      area: row.area,
      summary: row.summary,
      details: row.details,
      releasedAt: row.released_at,
    }))
  }

  claimNextAgentRun(workerId = '') {
    return this.transaction(() => {
      const row = this.database
        .prepare("SELECT * FROM agent_runs WHERE status = 'queued' ORDER BY queue_priority DESC, created_at ASC LIMIT 1")
        .get()
      if (!row) return null

      const now = new Date().toISOString()
      const result = this.database
        .prepare("UPDATE agent_runs SET status = 'running', worker_id = ?, heartbeat_at = ?, started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
        .run(workerId, now, now, now, row.id)
      return result.changes === 1 ? this.findAgentRun(row.id) : null
    })
  }

  acquireWorkerLease(name, ownerId, staleBefore) {
    return this.transaction(() => {
      const current = this.database.prepare('SELECT * FROM worker_leases WHERE name = ?').get(name)
      if (current && current.owner_id !== ownerId && current.heartbeat_at >= staleBefore) return false
      const now = new Date().toISOString()
      this.database.prepare(`
        INSERT INTO worker_leases (name, owner_id, heartbeat_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET owner_id = excluded.owner_id, heartbeat_at = excluded.heartbeat_at
      `).run(name, ownerId, now)
      return true
    })
  }

  heartbeatWorkerLease(name, ownerId) {
    return this.database
      .prepare('UPDATE worker_leases SET heartbeat_at = ? WHERE name = ? AND owner_id = ?')
      .run(new Date().toISOString(), name, ownerId).changes === 1
  }

  releaseWorkerLease(name, ownerId) {
    return this.database
      .prepare('DELETE FROM worker_leases WHERE name = ? AND owner_id = ?')
      .run(name, ownerId).changes === 1
  }

  ownsWorkerLease(name, ownerId) {
    if (!name || !ownerId) return false
    return Boolean(this.database
      .prepare('SELECT 1 FROM worker_leases WHERE name = ? AND owner_id = ?')
      .get(name, ownerId))
  }

  hasActiveRelease(taskId) {
    return Boolean(this.database.prepare(`
      SELECT 1
      FROM (
        SELECT status, release_status
        FROM agent_runs
        WHERE task_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      ) AS latest
      WHERE latest.status IN ('completed', 'needs_review')
        AND latest.release_status IN ('pending', 'processing', 'retrying')
    `).get(taskId))
  }

  heartbeatAgentRuns(workerId, runIds) {
    if (!workerId || runIds.length === 0) return 0
    const now = new Date().toISOString()
    const placeholders = runIds.map(() => '?').join(', ')
    return this.database.prepare(`
      UPDATE agent_runs SET heartbeat_at = ?, updated_at = ?
      WHERE worker_id = ? AND status = 'running' AND id IN (${placeholders})
    `).run(now, now, workerId, ...runIds).changes
  }

  requeueAgentRun(runId, workerId, reason = 'Перервано зупинкою worker, повернуто в чергу.') {
    const now = new Date().toISOString()
    return this.database.prepare(`
      UPDATE agent_runs
      SET status = 'queued', worker_id = '', heartbeat_at = NULL, control = '', started_at = NULL,
          error = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND worker_id = ?
    `).run(reason, now, runId, workerId).changes === 1
  }

  failAgentRun(runId, taskId, error, details = '') {
    const now = new Date().toISOString()
    return this.transaction(() => {
      this.database.prepare(`
        UPDATE agent_runs
        SET status = 'failed', error = ?, details = ?, finished_at = ?, updated_at = ?
        WHERE id = ?
      `).run(error, details, now, now, runId)
      const active = this.database
        .prepare("SELECT 1 FROM agent_runs WHERE task_id = ? AND status IN ('queued', 'running') LIMIT 1")
        .get(taskId)
      if (!active) {
        this.database.prepare("UPDATE tasks SET status = 'new', updated_at = ? WHERE id = ? AND status = 'in_progress'")
          .run(now, taskId)
      }
      return this.findAgentRun(runId)
    })
  }

  requestStop(taskId, { revert = false } = {}) {
    return this.transaction(() => {
      const row = this.database
        .prepare("SELECT * FROM agent_runs WHERE task_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1")
        .get(taskId)
      if (!row) return null

      const now = new Date().toISOString()
      const control = revert ? 'stop_revert' : 'stop'

      if (row.status === 'queued') {
        // Черговий ран ще не стартував: гасимо одразу, воркеру нічого вбивати.
        this.database
          .prepare("UPDATE agent_runs SET status = 'blocked', control = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?")
          .run(control, revert ? 'Знято з черги оператором (із відкатом).' : 'Знято з черги оператором.', now, now, row.id)
        return { run: this.findAgentRun(row.id), stoppedImmediately: true }
      }

      this.database
        .prepare('UPDATE agent_runs SET control = ?, updated_at = ? WHERE id = ?')
        .run(control, now, row.id)
      return { run: this.findAgentRun(row.id), stoppedImmediately: false }
    })
  }

  readControl(runId) {
    const row = this.database.prepare('SELECT control FROM agent_runs WHERE id = ?').get(runId)
    return row?.control ?? ''
  }

  markStopped(runId, { reverted = false } = {}) {
    const now = new Date().toISOString()
    this.database
      .prepare("UPDATE agent_runs SET status = 'blocked', control = '', error = ?, finished_at = ?, updated_at = ? WHERE id = ?")
      .run(reverted ? 'Зупинено оператором, зміни відкочено.' : 'Зупинено оператором.', now, now, runId)
    return this.findAgentRun(runId)
  }

  claimNextCleanupRun() {
    return this.transaction(() => {
      // Worktree спільний для ВСІХ прогонів задачі, тож відкат старої спроби
      // зносить теку під ногами свіжого рана (так загинула спроба 5 BUG-1003:
      // «зовнішній процес видалив робочу директорію»). Чекаємо, поки задача
      // звільниться, і аж тоді прибираємо.
      const row = this.database
        .prepare(`
          SELECT * FROM agent_runs AS candidate
          WHERE candidate.status = 'blocked'
            AND candidate.control = 'stop_revert'
            AND NOT EXISTS (
              SELECT 1 FROM agent_runs AS active
              WHERE active.task_id = candidate.task_id
                AND active.status IN ('queued', 'running')
            )
          ORDER BY candidate.updated_at ASC
          LIMIT 1
        `)
        .get()
      if (!row) return null
      const updated = this.database
        .prepare("UPDATE agent_runs SET control = 'cleanup_running', updated_at = ? WHERE id = ? AND control = 'stop_revert'")
        .run(new Date().toISOString(), row.id)
      return updated.changes === 1 ? this.findAgentRun(row.id) : null
    })
  }

  finishCleanupRun(runId, error = '') {
    this.database
      .prepare("UPDATE agent_runs SET control = '', error = ?, updated_at = ? WHERE id = ? AND control = 'cleanup_running'")
      .run(error, new Date().toISOString(), runId)
    return this.findAgentRun(runId)
  }

  reorderQueuedRun(taskId, direction) {
    return this.transaction(() => {
      const queued = this.database
        .prepare("SELECT * FROM agent_runs WHERE status = 'queued' ORDER BY queue_priority DESC, created_at ASC")
        .all()
      const index = queued.findIndex((row) => row.task_id === taskId)
      if (index < 0) return null

      const target = queued[index]
      const now = new Date().toISOString()

      if (direction === 'top') {
        if (index === 0) return agentRunFromRow(target)
        const topPriority = queued[0].queue_priority ?? 0
        this.database
          .prepare('UPDATE agent_runs SET queue_priority = ?, updated_at = ? WHERE id = ?')
          .run(topPriority + 1, now, target.id)
        return this.findAgentRun(target.id)
      }

      const neighbourIndex = direction === 'up' ? index - 1 : index + 1
      if (neighbourIndex < 0 || neighbourIndex >= queued.length) return agentRunFromRow(target)

      const neighbour = queued[neighbourIndex]
      const targetPriority = target.queue_priority ?? 0
      const neighbourPriority = neighbour.queue_priority ?? 0

      if (targetPriority === neighbourPriority) {
        // Однаковий пріоритет: порядок визначає created_at, тож піднімаємо
        // саме цільовий рядок на один щабель над сусідом.
        this.database
          .prepare('UPDATE agent_runs SET queue_priority = ?, updated_at = ? WHERE id = ?')
          .run(direction === 'up' ? neighbourPriority + 1 : neighbourPriority - 1, now, target.id)
      } else {
        this.database
          .prepare('UPDATE agent_runs SET queue_priority = ?, updated_at = ? WHERE id = ?')
          .run(neighbourPriority, now, target.id)
        this.database
          .prepare('UPDATE agent_runs SET queue_priority = ?, updated_at = ? WHERE id = ?')
          .run(targetPriority, now, neighbour.id)
      }

      return this.findAgentRun(target.id)
    })
  }

  updateAgentRun(id, values) {
    const allowedFields = [
      'status',
      'branch',
      'worktreePath',
      'summary',
      'details',
      'error',
      'finishedAt',
      'contextSnapshot',
      'codexSessionId',
    ]
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
      contextSnapshot: 'context_snapshot',
      codexSessionId: 'codex_session_id',
    }
    const assignments = fields.map((field) => `${columnNames[field]} = ?`).join(', ')
    this.database
      .prepare(`UPDATE agent_runs SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...fields.map((field) => values[field]), new Date().toISOString(), id)
    return this.findAgentRun(id)
  }

  updateAgentRunRelease(id, values, taskStatus = '') {
    const allowedFields = ['status', 'attempts', 'repositories', 'error', 'phase', 'evidence', 'releasedAt']
    const fields = allowedFields.filter((field) => Object.hasOwn(values, field))
    if (!fields.length && !taskStatus) return this.findAgentRun(id)
    const columns = {
      status: 'release_status',
      attempts: 'release_attempts',
      repositories: 'release_repositories',
      error: 'release_error',
      phase: 'release_phase',
      evidence: 'release_evidence',
      releasedAt: 'released_at',
    }
    const serialized = fields.map((field) => {
      if (field === 'repositories') return JSON.stringify([...new Set(values[field] ?? [])])
      if (field === 'evidence') return JSON.stringify(values[field] ?? {})
      return values[field]
    })
    const apply = () => {
      const now = new Date().toISOString()
      if (fields.length > 0) {
        const assignments = fields.map((field) => `${columns[field]} = ?`).join(', ')
        this.database.prepare(`UPDATE agent_runs SET ${assignments}, updated_at = ? WHERE id = ?`)
          .run(...serialized, now, id)
      }
      const updated = this.findAgentRun(id)
      if (!updated) return null
      if (taskStatus) {
        this.database.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
          .run(taskStatus, now, updated.taskId)
        if (values.status === 'released') this.markTaskProcessed(updated.taskId, 'codex')
      }
      return this.findAgentRun(id)
    }
    return taskStatus ? this.transaction(apply) : apply()
  }

  recoverInterruptedAgentRuns(olderThan = new Date(0).toISOString()) {
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE agent_runs
      SET status = 'failed', error = 'Worker було перезапущено під час виконання.', finished_at = ?, updated_at = ?
      WHERE status = 'running' AND updated_at < ?
    `).run(now, now, olderThan)
  }

  requeueOrphanedRuns() {
    // Воркер — єдиний власник черги. На старті звичайний orphaned run
    // повертаємо в чергу, але вже прийняту команду stop не скасовуємо.
    return this.transaction(() => {
      const now = new Date().toISOString()
      // Якщо процес упав уже під час cleanup, наступний власник lease має
      // повторити прибирання, а не залишити run назавжди у cleanup_running.
      this.database.prepare(`
        UPDATE agent_runs SET control = 'stop_revert', updated_at = ?
        WHERE status = 'blocked' AND control = 'cleanup_running'
      `).run(now)

      const orphaned = this.database
        .prepare("SELECT id, task_id, control FROM agent_runs WHERE status = 'running'")
        .all()
      const requeued = []
      for (const row of orphaned) {
        if (row.control === 'stop_revert') {
          this.database.prepare(`
            UPDATE agent_runs
            SET status = 'blocked', worker_id = '', heartbeat_at = NULL,
                error = 'Worker перезапущено після команди зупинки; worktree очікує очищення.',
                finished_at = ?, updated_at = ?
            WHERE id = ?
          `).run(now, now, row.id)
          this.database.prepare("UPDATE tasks SET status = 'new', updated_at = ? WHERE id = ?")
            .run(now, row.task_id)
          continue
        }
        if (row.control === 'stop') {
          this.database.prepare(`
            UPDATE agent_runs
            SET status = 'blocked', worker_id = '', heartbeat_at = NULL, control = '',
                error = 'Зупинено оператором під час перезапуску worker.', finished_at = ?, updated_at = ?
            WHERE id = ?
          `).run(now, now, row.id)
          this.database.prepare("UPDATE tasks SET status = 'new', updated_at = ? WHERE id = ?")
            .run(now, row.task_id)
          continue
        }
        this.database.prepare(`
          UPDATE agent_runs
          SET status = 'queued', worker_id = '', heartbeat_at = NULL, control = '', started_at = NULL,
              error = 'Перервано рестартом воркера, повернуто в чергу.', updated_at = ?
          WHERE id = ?
        `).run(now, row.id)
        requeued.push(row.task_id)
      }
      return requeued
    })
  }

  releaseStaleRunningRun(taskId, staleBefore) {
    return this.transaction(() => {
      const now = new Date().toISOString()
      const row = this.database
        .prepare(`
          SELECT id FROM agent_runs
          WHERE task_id = ? AND status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)
          ORDER BY created_at DESC LIMIT 1
        `)
        .get(taskId, staleBefore)
      if (!row) return null

      const released = this.database
        .prepare(`
          UPDATE agent_runs
          SET status = 'failed', worker_id = '', heartbeat_at = NULL, control = '',
              error = 'Знято оператором як зависле виконання.', finished_at = ?, updated_at = ?
          WHERE id = ? AND status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)
        `)
        .run(now, now, row.id, staleBefore)
      return released.changes === 1 ? this.findAgentRun(row.id) : null
    })
  }

  saveSystemState(key, payload) {
    const updatedAt = new Date().toISOString()
    this.database
      .prepare('INSERT OR REPLACE INTO system_state (key, payload, updated_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(payload), updatedAt)
    return { ...payload, updatedAt }
  }

  readSystemState(key) {
    const row = this.database.prepare('SELECT payload, updated_at FROM system_state WHERE key = ?').get(key)
    if (!row) return null
    try {
      return { ...JSON.parse(row.payload), updatedAt: row.updated_at }
    } catch {
      return null
    }
  }

  ensureBuild(buildNumber) {
    const number = String(buildNumber).trim()
    if (!number) throw new Error('Номер build не може бути порожнім.')
    const inserted = this.database
      .prepare('INSERT OR IGNORE INTO builds (number, created_at) VALUES (?, ?)')
      .run(number, new Date().toISOString())

    if (inserted.changes === 1 && number !== PENDING_BUILD) {
      this.database
        .prepare('UPDATE OR REPLACE build_tasks SET build_number = ? WHERE build_number = ?')
        .run(number, PENDING_BUILD)
    }
    return this.currentBuild(number)
  }

  markTaskProcessed(taskId, source = 'manual') {
    const task = this.find(taskId)
    if (!task) return null
    const number = PENDING_BUILD
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
    return null
  }

  buildTaskRows(buildNumber) {
    return this.database.prepare(`
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
    `).all(buildNumber)
  }

  currentBuild(buildNumber) {
    const number = String(buildNumber).trim()
    const build = this.database.prepare('SELECT * FROM builds WHERE number = ?').get(number)
    if (!build) return null
    return {
      number: build.number,
      createdAt: build.created_at,
      bugs: this.buildTaskRows(number).map(mapBuildTask),
      pending: number === PENDING_BUILD ? [] : this.buildTaskRows(PENDING_BUILD).map(mapBuildTask),
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
