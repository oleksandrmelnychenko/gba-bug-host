import {
  Bell,
  BellOff,
  Bot,
  Bug,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUp,
  CornerDownRight,
  History,
  Image as ImageIcon,
  Layers3,
  Link2,
  LockKeyhole,
  LoaderCircle,
  LogIn,
  LogOut,
  MessageSquare,
  EyeOff,
  Mic,
  Paperclip,
  Pencil,
  Play,
  Plus,
  Square,
  Undo2,
  RefreshCw,
  Search,
  Send,
  Trash2,
  UploadCloud,
  UserRound,
  X,
} from 'lucide-react'
import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from 'react'
import {
  addTaskComment,
  addTaskAttachments,
  createTask,
  deleteTask,
  deleteTaskAttachment,
  getCurrentBuild,
  getCurrentUser,
  getTaskAgentRuns,
  getTaskComments,
  getTasks,
  getUnreadComments,
  login,
  logout,
  markTaskCommentsRead,
  reorderQueuedTask,
  reviewTaskAgain,
  resumeAgentRun,
  stopAgentRun,
  transcribeAudio,
  updateTask,
} from './api'
import {
  priorityMeta,
  projectMeta,
  statusMeta,
  type AgentRun,
  type AgentRunStatus,
  type BuildBug,
  type BuildInfo,
  type AuthUser,
  type Task,
  type TaskAttachment,
  type TaskComment,
  type TaskDraft,
  type TaskPriority,
  type TaskProject,
  type TaskStatus,
  type UnreadComments,
  type UnreadTaskComment,
} from './types'
import { ArchitectureView } from './ArchitectureView'
import gbaLogo from './assets/brand/gba-logo.svg'

const emptyDraft: TaskDraft = {
  title: '',
  description: '',
  siteUrl: '',
  notes: '',
  staffComments: '',
  reviewComment: '',
  area: '',
  project: 'console',
  status: 'new',
  priority: 'medium',
}

const statusOrder: TaskStatus[] = ['new', 'in_progress', 'review_again', 'ready_for_retest', 'blocked', 'done']
const priorityOrder: TaskPriority[] = ['critical', 'high', 'medium', 'low']
const pageSizeOptions = [20, 50, 100]
const maxVoiceRecordingSeconds = 5 * 60
const recordingMimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
const dateFormatter = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})
const dateTimeFormatter = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function appendVoiceText(current: string, transcript: string, maxLength = 3000) {
  const existingText = current.trimEnd()
  const nextText = `${existingText}${existingText ? '\n' : ''}${transcript.trim()}`
  return nextText.slice(0, maxLength)
}

function formatRecordingTime(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  const rest = (seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${rest}`
}

type DateSortDirection = 'desc' | 'asc'

type WorkspaceTab = TaskProject | 'auto' | 'pipeline' | 'architecture'

const workspaceTabs: Array<{ key: WorkspaceTab; label: string }> = [
  { key: 'console', label: projectMeta.console.label },
  { key: 'ecommerce', label: projectMeta.ecommerce.label },
  { key: 'auto', label: 'Логи (авто)' },
  { key: 'pipeline', label: 'Конвеєр' },
  { key: 'architecture', label: 'Архітектура' },
]

const RELEASED_MARKER = /\[released:([^\]]+)\]/

function isTaskQueuedOrRunning(task: Task) {
  return task.agentRun?.status === 'queued' || task.agentRun?.status === 'running'
}

function isSentinelTask(task: Task) {
  return (task.notes ?? '').includes('[sentinel:')
}

const COLUMN_WIDTHS_STORAGE_KEY = 'gba-qa-desk-column-widths-v2'
const tableColumns: Array<{ key: string; label: string; className?: string; srOnly?: boolean }> = [
  { key: 'title', label: 'Задача' },
  { key: 'created', label: 'Створено', className: 'column-created' },
  { key: 'status', label: 'Статус' },
  { key: 'area', label: 'Розділ' },
  { key: 'url', label: 'URL сторінки' },
  { key: 'notes', label: 'Нотатки' },
  { key: 'priority', label: 'Пріоритет' },
  { key: 'evidence', label: 'Докази' },
  { key: 'action', label: 'Відкрити', className: 'column-action', srOnly: true },
]

const agentRunMeta: Record<AgentRunStatus, { label: string; shortLabel: string }> = {
  queued: { label: 'У черзі', shortLabel: 'Черга' },
  running: { label: 'Codex працює', shortLabel: 'Codex' },
  completed: { label: 'Виправлено', shortLabel: 'Готово' },
  needs_review: { label: 'Потрібен повторний перегляд', shortLabel: 'Перегляд' },
  blocked: { label: 'Codex заблокований', shortLabel: 'Блок' },
  failed: { label: 'Запуск завершився помилкою', shortLabel: 'Помилка' },
}

function formatDate(value: string) {
  return dateFormatter.format(new Date(value))
}

function formatDateTime(value: string) {
  return dateTimeFormatter.format(new Date(value))
}

function mediaLabel(count: number) {
  const lastTwoDigits = count % 100
  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return `${count} файлів`
  const lastDigit = count % 10
  if (lastDigit === 1) return `${count} файл`
  if (lastDigit >= 2 && lastDigit <= 4) return `${count} файли`
  return `${count} файлів`
}

function isVideo(attachment: Pick<TaskAttachment, 'kind' | 'type'>) {
  return attachment.kind === 'video' || attachment.type.startsWith('video/')
}

function taskToDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    siteUrl: task.siteUrl,
    notes: task.notes,
    staffComments: task.staffComments,
    reviewComment: task.reviewComment,
    area: task.area,
    project: task.project ?? 'console',
    status: task.status,
    priority: task.priority,
  }
}

function StatusSelect({
  value,
  onChange,
  disabled = false,
  compact = false,
}: {
  value: TaskStatus
  onChange: (value: TaskStatus) => void
  disabled?: boolean
  compact?: boolean
}) {
  return (
    <div className={`status-select-wrap status-${value} ${compact ? 'is-compact' : ''}`}>
      <span className="status-dot" aria-hidden="true" />
      <select
        aria-label="Статус задачі"
        value={value}
        onChange={(event) => onChange(event.target.value as TaskStatus)}
        disabled={disabled}
      >
        {statusOrder.map((status) => (
          <option key={status} value={status}>{statusMeta[status].label}</option>
        ))}
      </select>
      <ChevronDown size={13} aria-hidden="true" />
    </div>
  )
}

function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <span className={`priority-badge priority-${priority}`}>
      <span aria-hidden="true" />
      {priorityMeta[priority].label}
    </span>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-state-mark"><Search size={26} /></div>
      <h3>Нічого не знайшлося</h3>
      <p>Змініть фільтри або зафіксуйте нову задачу.</p>
      <button className="button button-primary" onClick={onCreate}><Plus size={17} /> Нова задача</button>
    </div>
  )
}

function BuildBugRow({
  bug,
  pending = false,
  onOpen,
}: {
  bug: BuildBug
  pending?: boolean
  onOpen: () => void
}) {
  return (
    <button type="button" className={`build-bug-row${pending ? ' is-pending' : ''}`} onClick={onOpen}>
      <span className="build-bug-id">{bug.id}</span>
      <span className="build-bug-copy">
        <strong>{bug.title}</strong>
        <small>
          {bug.area}
          <span
            className={`build-status-chip status-${bug.status}`}
            title={`У момент випуску: ${statusMeta[bug.statusAtProcessing].label}`}
          >
            {statusMeta[bug.status].shortLabel}
          </span>
        </small>
      </span>
      <span className={`build-source build-source-${bug.source}`}>{bug.source === 'codex' ? 'AI' : 'QA'}</span>
    </button>
  )
}

function BuildTicker({
  refreshKey,
  onOpenTask,
  onBuildChanged,
}: {
  refreshKey: string
  onOpenTask: (taskId: string) => void
  onBuildChanged: (buildNumber: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [build, setBuild] = useState<BuildInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const knownNumberRef = useRef('')

  const loadBuild = async () => {
    setLoading(true)
    setError('')
    try {
      const next = await getCurrentBuild()
      setBuild(next)
      if (knownNumberRef.current && knownNumberRef.current !== next.number) onBuildChanged(next.number)
      knownNumberRef.current = next.number
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не вдалося завантажити build.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadBuild()
  }, [refreshKey])

  useEffect(() => {
    const interval = window.setInterval(() => void loadBuild(), 60_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div className="build-ticker" ref={rootRef}>
      <button
        type="button"
        className="build-ticker-button"
        onClick={() => {
          setOpen((current) => !current)
          if (!open) void loadBuild()
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="build-live-dot" aria-hidden="true" />
        <span className="build-label">BUILD</span>
        <strong>{build?.number ?? '—'}</strong>
        <span className="build-bug-count"><Bug size={11} /> {build?.bugs.length ?? 0}</span>
        <ChevronUp className={open ? 'is-open' : ''} size={14} />
      </button>

      {open && (
        <section className="build-popover" role="dialog" aria-label="Баги поточного build">
          <div className="build-popover-head">
            <div>
              <span>Поточний build</span>
              <strong>{build?.number ?? '—'}</strong>
            </div>
            <span>{build?.bugs.length ?? 0} опрацьовано</span>
          </div>

          {loading ? (
            <div className="build-popover-state"><LoaderCircle className="spin" size={17} /> Завантажую…</div>
          ) : error ? (
            <button className="build-popover-state build-retry" onClick={() => void loadBuild()}>{error} Спробувати ще</button>
          ) : build?.bugs.length || build?.pending.length ? (
            <div className="build-bug-list">
              {build.bugs.map((bug) => (
                <BuildBugRow
                  key={bug.id}
                  bug={bug}
                  onOpen={() => {
                    onOpenTask(bug.id)
                    setOpen(false)
                  }}
                />
              ))}

              {build.pending.length > 0 && (
                <>
                  <div className="build-bug-divider">Чекають на наступний деплой · {build.pending.length}</div>
                  {build.pending.map((bug) => (
                    <BuildBugRow
                      key={`pending-${bug.id}`}
                      bug={bug}
                      pending
                      onOpen={() => {
                        onOpenTask(bug.id)
                        setOpen(false)
                      }}
                    />
                  ))}
                </>
              )}
            </div>
          ) : (
            <div className="build-popover-empty">
              <Bug size={20} />
              <span>У цьому build ще немає опрацьованих багів.</span>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function AttachmentStack({
  task,
  onOpen,
}: {
  task: Task
  onOpen: (attachment: TaskAttachment) => void
}) {
  if (!task.attachments.length) {
    return <span className="no-attachments"><ImageIcon size={15} /> 0</span>
  }

  return (
    <div className="attachment-stack" aria-label={mediaLabel(task.attachments.length)}>
      {task.attachments.slice(0, 2).map((attachment) => (
        <button
          key={attachment.id}
          className="mini-thumbnail"
          onClick={(event) => {
            event.stopPropagation()
            onOpen(attachment)
          }}
          aria-label={`Відкрити ${attachment.name}`}
        >
          {isVideo(attachment) ? (
            <>
              <video src={attachment.url} muted preload="metadata" />
              <span className="mini-video-mark"><Play size={9} fill="currentColor" /></span>
            </>
          ) : <img src={attachment.url} alt="" />}
        </button>
      ))}
      {task.attachments.length > 2 && <span className="attachment-more">+{task.attachments.length - 2}</span>}
    </div>
  )
}

function TaskTable({
  tasks,
  updatingId,
  queueingId,
  scrollable = false,
  sortDirection,
  onOpenTask,
  onStatusChange,
  onSortDirectionChange,
  onOpenAttachment,
  onEnqueue,
}: {
  tasks: Task[]
  updatingId: string | null
  queueingId: string | null
  scrollable?: boolean
  sortDirection: DateSortDirection
  onOpenTask: (task: Task) => void
  onStatusChange: (task: Task, status: TaskStatus) => void
  onSortDirectionChange: (direction: DateSortDirection) => void
  onOpenAttachment: (attachment: TaskAttachment) => void
  onEnqueue: (task: Task) => void
}) {
  const headerRowRef = useRef<HTMLTableRowElement | null>(null)
  const [columnWidths, setColumnWidths] = useState<Record<string, number> | null>(() => {
    try {
      const raw = localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Record<string, number>
      return tableColumns.every((column) => typeof parsed[column.key] === 'number') ? parsed : null
    } catch {
      return null
    }
  })

  useEffect(() => {
    if (columnWidths) localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(columnWidths))
    else localStorage.removeItem(COLUMN_WIDTHS_STORAGE_KEY)
  }, [columnWidths])

  const startColumnResize = (key: string, event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const headerRow = headerRowRef.current
    if (!headerRow) return

    const baseline = columnWidths ?? Object.fromEntries(
      tableColumns.map((column, index) => [column.key, headerRow.cells[index]?.offsetWidth ?? 120]),
    )
    const startX = event.clientX
    const startWidth = baseline[key]

    const onMove = (moveEvent: PointerEvent) => {
      const width = Math.min(900, Math.max(56, Math.round(startWidth + moveEvent.clientX - startX)))
      setColumnWidths({ ...baseline, [key]: width })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const resetColumnWidths = () => setColumnWidths(null)

  return (
    <>
      <div className={`table-scroll${scrollable ? ' table-scroll-capped' : ''}`}>
        <table className="task-table" style={columnWidths ? { tableLayout: 'fixed' } : undefined}>
          {columnWidths && (
            <colgroup>
              {tableColumns.map((column) => (
                <col key={column.key} style={{ width: `${columnWidths[column.key]}px` }} />
              ))}
            </colgroup>
          )}
          <thead>
            <tr ref={headerRowRef}>
              {tableColumns.map((column, index) => (
                <th key={column.key} className={column.className}>
                  {column.key === 'created' ? (
                    <button
                      type="button"
                      className="sort-heading"
                      onClick={() => onSortDirectionChange(sortDirection === 'desc' ? 'asc' : 'desc')}
                      aria-label={`Сортування за датою створення: ${sortDirection === 'desc' ? 'спочатку нові' : 'спочатку старі'}`}
                    >
                      Створено
                      {sortDirection === 'desc' ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                    </button>
                  ) : column.srOnly ? (
                    <span className="sr-only">{column.label}</span>
                  ) : column.label}
                  {index < tableColumns.length - 1 && (
                    <span
                      className="column-resizer"
                      title="Потягніть, щоб змінити ширину. Подвійний клік — скинути."
                      onPointerDown={(event) => startColumnResize(column.key, event)}
                      onDoubleClick={resetColumnWidths}
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tasks.map((task, index) => (
                <tr
                  key={task.id}
                  onClick={() => onOpenTask(task)}
                  style={{ '--row-delay': `${Math.min(index, 7) * 35}ms` } as React.CSSProperties}
                >
                  <td className="task-main-column">
                    <div className="task-title-cell">
                      <strong>{task.title}</strong>
                      <div className="task-title-meta">
                        <span className="task-id">{task.id}</span>
                        {task.agentRun && (task.agentRun.status === 'queued' || task.agentRun.status === 'running') ? (
                          <span className={`codex-progress codex-progress-${task.agentRun.status}`} title={agentRunMeta[task.agentRun.status].label}>
                            <LoaderCircle className="spin" size={10} />
                            {task.agentRun.status === 'running' ? 'Codex' : 'Черга'}
                          </span>
                        ) : task.agentRun ? (
                          <span className={`agent-table-state agent-run-${task.agentRun.status}`} title={agentRunMeta[task.agentRun.status].label}>
                            <Bot size={10} /> {agentRunMeta[task.agentRun.status].shortLabel}
                          </span>
                        ) : null}
                        <span className="task-description">{task.description || 'Без додаткового опису'}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <time className="created-at" dateTime={task.createdAt}>{formatDateTime(task.createdAt)}</time>
                  </td>
                  <td onClick={(event) => event.stopPropagation()}>
                    <StatusSelect
                      value={task.status}
                      compact
                      disabled={updatingId === task.id}
                      onChange={(status) => onStatusChange(task, status)}
                    />
                  </td>
                  <td><span className="area-label">{task.area}</span></td>
                  <td>
                    {task.siteUrl ? (
                      <a
                        className="task-url"
                        href={task.siteUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => event.stopPropagation()}
                        title={task.siteUrl}
                      >
                        <Link2 size={13} />
                        <span>{new URL(task.siteUrl).hostname}</span>
                      </a>
                    ) : <span className="empty-cell">—</span>}
                  </td>
                  <td><span className="notes-cell" title={task.notes}>{task.notes || '—'}</span></td>
                  <td><PriorityBadge priority={task.priority} /></td>
                  <td><AttachmentStack task={task} onOpen={onOpenAttachment} /></td>
                  <td onClick={(event) => event.stopPropagation()}>
                    <div className="row-actions">
                      <button
                        className="row-arrow row-arrow-queue"
                        disabled={isTaskQueuedOrRunning(task) || queueingId === task.id}
                        onClick={() => onEnqueue(task)}
                        aria-label={`Додати ${task.id} в чергу Codex`}
                        title={isTaskQueuedOrRunning(task) ? 'Уже в конвеєрі Codex' : 'Додати в чергу Codex'}
                      >
                        {queueingId === task.id ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
                      </button>
                      <button className="row-arrow" onClick={() => onOpenTask(task)} aria-label={`Редагувати ${task.id}`} title="Редагувати"><Pencil size={15} /></button>
                    </div>
                  </td>
                </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="task-cards">
        {tasks.map((task) => (
          <article className="task-card" key={task.id} onClick={() => onOpenTask(task)}>
            <div className="task-card-topline">
              <span className="task-id">{task.id}</span>
              <PriorityBadge priority={task.priority} />
            </div>
            <h3>{task.title}</h3>
            <p>{task.description || 'Без додаткового опису'}</p>
            <div className="task-card-meta">
              <span><Layers3 size={14} /> {task.area}</span>
              <time dateTime={task.createdAt}><CalendarDays size={14} /> {formatDateTime(task.createdAt)}</time>
            </div>
            {task.siteUrl && (
              <a
                className="task-card-url"
                href={task.siteUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
              ><Link2 size={14} /> {new URL(task.siteUrl).hostname}</a>
            )}
            {task.notes && <pre className="task-card-notes">{task.notes}</pre>}
            <div className="task-card-footer" onClick={(event) => event.stopPropagation()}>
              <button
                className="row-arrow row-arrow-queue"
                disabled={isTaskQueuedOrRunning(task) || queueingId === task.id}
                onClick={() => onEnqueue(task)}
                aria-label={`Додати ${task.id} в чергу Codex`}
                title={isTaskQueuedOrRunning(task) ? 'Уже в конвеєрі Codex' : 'Додати в чергу Codex'}
              >
                {queueingId === task.id ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
              </button>
              <StatusSelect
                value={task.status}
                compact
                disabled={updatingId === task.id}
                onChange={(status) => onStatusChange(task, status)}
              />
              <AttachmentStack task={task} onOpen={onOpenAttachment} />
            </div>
          </article>
        ))}
      </div>
    </>
  )
}

function TaskPagination({
  page,
  pageCount,
  pageSize,
  filteredTotal,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number
  pageCount: number
  pageSize: number
  filteredTotal: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}) {
  const rangeStart = filteredTotal ? (page - 1) * pageSize + 1 : 0
  const rangeEnd = Math.min(page * pageSize, filteredTotal)

  return (
    <div className="table-footer">
      <span>
        Показано {rangeStart}–{rangeEnd} із {filteredTotal}
        {filteredTotal !== total ? ` · усього ${total}` : ''}
      </span>
      <div className="pagination-controls" aria-label="Пагінація задач">
        <label className="page-size-select">
          <span>На сторінці</span>
          <select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))} aria-label="Кількість задач на сторінці">
            {pageSizeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => onPageChange(page - 1)} disabled={page === 1} aria-label="Попередня сторінка">
          <ChevronLeft size={16} />
        </button>
        <span className="page-indicator">Сторінка {page} з {pageCount}</span>
        <button type="button" onClick={() => onPageChange(page + 1)} disabled={page === pageCount} aria-label="Наступна сторінка">
          <ChevronRight size={16} />
        </button>
      </div>
      <span className="auto-save-state"><i /> Зміни зберігаються автоматично</span>
    </div>
  )
}

function UploadZone({
  files,
  onFiles,
  inputId,
}: {
  files: File[]
  onFiles: (files: File[]) => void
  inputId?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  )

  useEffect(() => () => {
    for (const preview of previews) URL.revokeObjectURL(preview.url)
  }, [previews])

  const addFiles = (incoming: File[]) => {
    const media = incoming.filter((file) => file.type.startsWith('image/') || file.type.startsWith('video/'))
    onFiles([...files, ...media].slice(0, 6))
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    addFiles(Array.from(event.dataTransfer.files))
  }

  return (
    <div>
      <div
        className="upload-zone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click()
        }}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif,video/mp4,video/webm,video/quicktime"
          multiple
          hidden
          onChange={(event) => addFiles(Array.from(event.target.files ?? []))}
        />
        <span className="upload-icon"><UploadCloud size={22} /></span>
        <div>
          <strong>Перетягніть фото або відео сюди</strong>
          <span>до 6 файлів · фото 10 МБ · відео 200 МБ</span>
        </div>
      </div>
      {previews.length > 0 && (
        <div className="preview-strip">
          {previews.map(({ file, url }, index) => (
            <div className="preview-item" key={`${file.name}-${file.lastModified}`}>
              {file.type.startsWith('video/') ? (
                <>
                  <video src={url} muted preload="metadata" />
                  <span className="preview-video-mark"><Play size={12} fill="currentColor" /></span>
                </>
              ) : <img src={url} alt="" />}
              <button
                type="button"
                onClick={() => onFiles(files.filter((_, fileIndex) => fileIndex !== index))}
                aria-label={`Видалити ${file.name}`}
              ><X size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function VoiceInputButton({ onTranscript }: { onTranscript: (text: string) => void }) {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const mountedRef = useRef(true)
  const recordingFailedRef = useRef(false)

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const recorder = recorderRef.current
      if (recorder) {
        recorder.ondataavailable = null
        recorder.onstop = null
        recorder.onerror = null
        if (recorder.state !== 'inactive') recorder.stop()
      }
      stopStream()
    }
  }, [])

  useEffect(() => {
    if (phase !== 'recording') return
    const timer = window.setInterval(() => setElapsed((current) => current + 1), 1000)
    return () => window.clearInterval(timer)
  }, [phase])

  useEffect(() => {
    if (phase === 'recording' && elapsed >= maxVoiceRecordingSeconds && recorderRef.current?.state !== 'inactive') {
      recorderRef.current?.stop()
    }
  }, [elapsed, phase])

  const startRecording = async () => {
    setError('')
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Запис голосу потребує сучасного браузера та HTTPS-з’єднання.')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      streamRef.current = stream
      const mimeType = recordingMimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate))
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      const chunks: BlobPart[] = []
      recordingFailedRef.current = false
      recorderRef.current = recorder

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder.onerror = () => {
        recordingFailedRef.current = true
        stopStream()
        if (mountedRef.current) {
          setPhase('idle')
          setError('Запис перервався. Спробуйте ще раз.')
        }
      }
      recorder.onstop = async () => {
        recorderRef.current = null
        stopStream()
        if (!mountedRef.current || recordingFailedRef.current) return

        const audio = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
        if (!audio.size) {
          setPhase('idle')
          setError('Не вдалося записати звук. Перевірте мікрофон і спробуйте ще раз.')
          return
        }

        setPhase('transcribing')
        try {
          const result = await transcribeAudio(audio)
          if (!mountedRef.current) return
          onTranscript(result.text)
          setPhase('idle')
        } catch (caughtError) {
          if (!mountedRef.current) return
          setPhase('idle')
          setError(caughtError instanceof Error ? caughtError.message : 'Не вдалося розпізнати голос.')
        }
      }

      setElapsed(0)
      recorder.start(1000)
      setPhase('recording')
    } catch (caughtError) {
      stopStream()
      const errorName = caughtError instanceof DOMException ? caughtError.name : ''
      setError(
        errorName === 'NotAllowedError'
          ? 'Дозвольте доступ до мікрофона в налаштуваннях браузера.'
          : errorName === 'NotFoundError'
            ? 'Мікрофон не знайдено.'
            : 'Не вдалося почати запис голосу.',
      )
    }
  }

  const stopRecording = () => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
  }

  const isRecording = phase === 'recording'
  const isTranscribing = phase === 'transcribing'
  const label = isRecording
    ? 'Зупинити запис і перетворити голос у текст'
    : isTranscribing
      ? 'Розпізнаю голос'
      : 'Записати опис голосом'

  return (
    <>
      <div className={`voice-input-actions ${isRecording ? 'is-recording' : ''}`}>
        {isRecording && <span className="voice-recording-time" aria-hidden="true"><i />{formatRecordingTime(elapsed)}</span>}
        {isTranscribing && <span className="voice-transcribing-label" role="status">Перетворюю в текст…</span>}
        <button
          type="button"
          className="voice-input-button"
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isTranscribing}
          aria-label={label}
          title={label}
        >
          {isTranscribing
            ? <LoaderCircle className="spin" size={17} />
            : isRecording
              ? <Square size={13} fill="currentColor" />
              : <Mic size={18} />}
        </button>
      </div>
      {error && <small className="voice-input-error" role="alert">{error}</small>}
    </>
  )
}

function CreateTaskDialog({
  open,
  project,
  onClose,
  onCreated,
}: {
  open: boolean
  project: TaskProject
  onClose: () => void
  onCreated: (task: Task) => void
}) {
  const [draft, setDraft] = useState<TaskDraft>(emptyDraft)
  const [files, setFiles] = useState<File[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const setField = <Key extends keyof TaskDraft>(key: Key, value: TaskDraft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const task = await createTask({ ...draft, project }, files)
      onCreated(task)
      setDraft(emptyDraft)
      setFiles([])
      onClose()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не вдалося створити задачу.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="task-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="create-title">
        <div className="dialog-header">
          <div>
            <span className="eyebrow">Нова задача · {projectMeta[project].label}</span>
            <h2 id="create-title">Зафіксувати баг</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Закрити"><X size={19} /></button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-field form-field-wide">
            <label htmlFor="new-title">Що зламалося? <span>*</span></label>
            <input
              id="new-title"
              autoFocus
              required
              minLength={3}
              maxLength={140}
              value={draft.title}
              onChange={(event) => setField('title', event.target.value)}
              placeholder="Наприклад: Пошук падає після очищення поля"
            />
          </div>
          <div className="form-field form-field-wide">
            <label htmlFor="new-description">Опис</label>
            <div className="voice-textarea">
              <textarea
                id="new-description"
                rows={4}
                maxLength={3000}
                value={draft.description}
                onChange={(event) => setField('description', event.target.value)}
                placeholder="Коротко опишіть кроки й очікуваний результат…"
              />
              <VoiceInputButton
                onTranscript={(text) => setDraft((current) => ({
                  ...current,
                  description: appendVoiceText(current.description, text),
                }))}
              />
            </div>
          </div>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="new-area">Розділ</label>
              <input id="new-area" maxLength={80} value={draft.area} onChange={(event) => setField('area', event.target.value)} placeholder="Продажі" />
            </div>
            <div className="form-field">
              <label htmlFor="new-site-url">URL сторінки</label>
              <input
                id="new-site-url"
                type="text"
                inputMode="url"
                maxLength={2048}
                value={draft.siteUrl}
                onChange={(event) => setField('siteUrl', event.target.value)}
                placeholder="https://example.com/problem-page"
              />
            </div>
          </div>
          <div className="form-field form-field-wide">
            <label htmlFor="new-notes">Нотатки</label>
            <textarea
              id="new-notes"
              className="technical-notes"
              rows={3}
              maxLength={10000}
              value={draft.notes}
              onChange={(event) => setField('notes', event.target.value)}
              placeholder={'POST /api/orders\nPayload: { ... }\nResponse: 500 — без паролів і токенів'}
            />
          </div>
          <div className="form-field form-field-wide staff-comments-field">
            <div className="staff-comments-heading">
              <label htmlFor="new-staff-comments">Коментарі співробітників</label>
              <span><EyeOff size={13} /> AI не читає</span>
            </div>
            <textarea
              id="new-staff-comments"
              rows={3}
              maxLength={5000}
              value={draft.staffComments}
              onChange={(event) => setField('staffComments', event.target.value)}
              placeholder="Внутрішні домовленості, відповідальні або контекст для команди…"
            />
            <small>Зберігається тільки в задачі та не передається Codex.</small>
          </div>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="new-priority">Пріоритет</label>
              <div className="native-select">
                <select id="new-priority" value={draft.priority} onChange={(event) => setField('priority', event.target.value as TaskPriority)}>
                  {priorityOrder.map((priority) => <option value={priority} key={priority}>{priorityMeta[priority].label}</option>)}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            <div className="form-field">
              <label htmlFor="new-status">Статус</label>
              <div className="native-select">
                <select id="new-status" value={draft.status} onChange={(event) => setField('status', event.target.value as TaskStatus)}>
                  {statusOrder.filter((status) => status !== 'review_again').map((status) => <option value={status} key={status}>{statusMeta[status].label}</option>)}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
          </div>

          <div className="form-field form-field-wide">
            <label>Фото та відео</label>
            <UploadZone files={files} onFiles={setFiles} />
          </div>

          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>Скасувати</button>
            <button type="submit" className="button button-primary" disabled={saving || draft.title.trim().length < 3}>
              {saving ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}
              {saving ? 'Зберігаю…' : 'Створити задачу'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}

interface CommentRow {
  comment: TaskComment
  depth: number
}

function flattenCommentTree(comments: TaskComment[]) {
  const byParent = new Map<string | null, TaskComment[]>()
  const knownIds = new Set(comments.map((comment) => comment.id))

  for (const comment of comments) {
    const parentId = comment.parentId && knownIds.has(comment.parentId) ? comment.parentId : null
    const siblings = byParent.get(parentId) ?? []
    siblings.push(comment)
    byParent.set(parentId, siblings)
  }

  const rows: CommentRow[] = []
  const append = (parentId: string | null, depth: number) => {
    for (const comment of byParent.get(parentId) ?? []) {
      rows.push({ comment, depth })
      append(comment.id, depth + 1)
    }
  }
  append(null, 0)
  return rows
}

function commentInitials(author: string) {
  return author
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toLocaleUpperCase('uk-UA')
}

function TaskComments({ taskId, user, focusCommentId }: { taskId: string; user: AuthUser; focusCommentId: string | null }) {
  const [comments, setComments] = useState<TaskComment[]>([])
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void getTaskComments(taskId)
      .then((nextComments) => {
        if (!cancelled) {
          setComments(nextComments)
          void markTaskCommentsRead(taskId).then(() => {
            window.dispatchEvent(new Event('qa-desk-comments-changed'))
          }).catch(() => undefined)
        }
      })
      .catch((caughtError) => {
        if (!cancelled) setError(caughtError instanceof Error ? caughtError.message : 'Не вдалося завантажити коментарі.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [taskId, refreshKey])

  useEffect(() => {
    if (loading || !focusCommentId || !comments.some((comment) => comment.id === focusCommentId)) return
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`comment-${focusCommentId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [comments, focusCommentId, loading])

  const rows = useMemo(() => flattenCommentTree(comments), [comments])
  const replyTarget = replyTo ? comments.find((comment) => comment.id === replyTo) ?? null : null

  const selectReply = (comment: TaskComment) => {
    setReplyTo(comment.id)
    setError('')
    bodyRef.current?.focus()
  }

  const submit = async () => {
    const cleanBody = body.trim()
    if (!cleanBody) {
      setError('Напишіть текст коментаря.')
      return
    }

    setSaving(true)
    setError('')
    try {
      const comment = await addTaskComment(taskId, {
        body: cleanBody,
        parentId: replyTo,
      })
      setComments((current) => [...current, comment])
      setBody('')
      setReplyTo(null)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не вдалося додати коментар.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="staff-thread" aria-labelledby={`staff-thread-${taskId}`}>
      <div className="staff-comments-heading">
        <div>
          <span className="eyebrow">Внутрішня дискусія</span>
          <h3 id={`staff-thread-${taskId}`}>
            <MessageSquare size={17} /> Коментарі співробітників
            {comments.length > 0 && <span className="comment-count">{comments.length}</span>}
          </h3>
        </div>
        <span><EyeOff size={13} /> AI не читає</span>
      </div>

      <div className="comment-list" aria-live="polite">
        {loading ? (
          <div className="comments-state"><LoaderCircle className="spin" size={17} /> Завантажую коментарі…</div>
        ) : rows.length > 0 ? rows.map(({ comment, depth }) => (
          <article
            id={`comment-${comment.id}`}
            className={`comment-card ${depth > 0 ? 'is-reply' : ''}${focusCommentId === comment.id ? ' is-focused' : ''}`}
            style={{ marginInlineStart: `${Math.min(depth, 4) * 24}px` }}
            key={comment.id}
          >
            <div className="comment-avatar" aria-hidden="true">{commentInitials(comment.author)}</div>
            <div className="comment-content">
              <header>
                <strong>{comment.author}</strong>
                <time dateTime={comment.createdAt}>{formatDateTime(comment.createdAt)}</time>
              </header>
              <p>{comment.body}</p>
              <button type="button" className="comment-reply-button" onClick={() => selectReply(comment)}>
                <CornerDownRight size={13} /> Відповісти
              </button>
            </div>
          </article>
        )) : !error ? (
          <div className="comments-state is-empty">Ще немає коментарів. Почніть внутрішню дискусію.</div>
        ) : null}
      </div>

      {replyTarget && (
        <div className="comment-reply-target">
          <CornerDownRight size={14} /> Відповідь для <strong>{replyTarget.author}</strong>
          <button type="button" onClick={() => setReplyTo(null)} aria-label="Скасувати відповідь"><X size={14} /></button>
        </div>
      )}
      <div className="comment-composer">
        <div className="comment-composer-user" title={user.email}>
          <span>{commentInitials(user.displayName)}</span>
          <div><strong>{user.displayName}</strong><small>Від вашого акаунта</small></div>
        </div>
        <label className="comment-body-field" htmlFor={`comment-body-${taskId}`}>
          Коментар
          <textarea
            ref={bodyRef}
            id={`comment-body-${taskId}`}
            rows={3}
            maxLength={5000}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
            placeholder={replyTarget ? `Відповісти ${replyTarget.author}…` : 'Внутрішня домовленість, уточнення або відповідь…'}
          />
        </label>
        <button
          type="button"
          className="button button-primary comment-send-button"
          onClick={() => void submit()}
          disabled={saving || !body.trim()}
        >
          {saving ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}
          {saving ? 'Надсилаю…' : replyTarget ? 'Відповісти' : 'Додати'}
        </button>
      </div>
      {error && (
        <div className="comment-error" role="alert">
          <span>{error}</span>
          {!loading && comments.length === 0 && (
            <button type="button" onClick={() => setRefreshKey((value) => value + 1)}>Повторити</button>
          )}
        </div>
      )}
      <small className="comment-privacy-note">Коментарі доступні команді в Desk і не передаються Codex.</small>
    </section>
  )
}

function EditTaskDialog({
  task,
  user,
  focusCommentId,
  onClose,
  onUpdated,
  onReviewAgain,
  onDeleted,
  onOpenAttachment,
}: {
  task: Task | null
  user: AuthUser
  focusCommentId: string | null
  onClose: () => void
  onUpdated: (task: Task) => void
  onReviewAgain: (task: Task, patch: TaskDraft) => void
  onDeleted: (id: string) => void
  onOpenAttachment: (attachment: TaskAttachment) => void
}) {
  const [draft, setDraft] = useState<TaskDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (task) {
      setDraft(taskToDraft(task))
      setError('')
    }
  }, [task?.id, task?.updatedAt])

  useEffect(() => {
    if (!task) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [task?.id, onClose])

  if (!task) return null

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (draft.status === 'review_again' && task.status !== 'review_again') {
      onReviewAgain(task, draft)
      return
    }
    setSaving(true)
    setError('')
    try {
      onUpdated(await updateTask(task.id, draft))
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не вдалося зберегти зміни.')
    } finally {
      setSaving(false)
    }
  }

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).slice(0, 6)
    event.target.value = ''
    if (!files.length) return
    setUploading(true)
    setError('')
    try {
      onUpdated(await addTaskAttachments(task.id, files))
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не вдалося завантажити зображення.')
    } finally {
      setUploading(false)
    }
  }

  const removeAttachment = async (attachmentId: string) => {
    try {
      onUpdated(await deleteTaskAttachment(task.id, attachmentId))
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не вдалося видалити зображення.')
    }
  }

  const removeTask = async () => {
    if (!window.confirm(`Видалити ${task.id}? Цю дію неможливо скасувати.`)) return
    setSaving(true)
    try {
      await deleteTask(task.id)
      onDeleted(task.id)
      onClose()
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не вдалося видалити задачу.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="task-dialog edit-task-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="edit-task-title">
        <div className="dialog-header">
          <div>
            <span className="eyebrow">{task.id}</span>
            <h2 id="edit-task-title">Редагувати задачу</h2>
            <span className="updated-at">Оновлено {formatDate(task.updatedAt)}</span>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Закрити"><X size={19} /></button>
        </div>

        <form onSubmit={save}>
          <div className="form-field form-field-wide">
            <label htmlFor="detail-title">Назва</label>
            <input id="detail-title" required minLength={3} maxLength={140} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </div>
          <div className="form-field form-field-wide">
            <label htmlFor="detail-description">Опис</label>
            <div className="voice-textarea">
              <textarea id="detail-description" rows={5} maxLength={3000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
              <VoiceInputButton
                onTranscript={(text) => setDraft((current) => ({
                  ...current,
                  description: appendVoiceText(current.description, text),
                }))}
              />
            </div>
          </div>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="detail-area">Розділ</label>
              <input id="detail-area" maxLength={80} value={draft.area} onChange={(event) => setDraft({ ...draft, area: event.target.value })} />
            </div>
            <div className="form-field">
              <label htmlFor="detail-site-url">URL сторінки</label>
              <input id="detail-site-url" type="text" inputMode="url" maxLength={2048} value={draft.siteUrl} onChange={(event) => setDraft({ ...draft, siteUrl: event.target.value })} placeholder="https://example.com/problem-page" />
            </div>
          </div>
          <div className="form-field form-field-wide">
            <label htmlFor="detail-notes">Нотатки</label>
            <textarea id="detail-notes" className="technical-notes" rows={5} maxLength={10000} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="HTTP request, payload, response — без паролів і токенів" />
          </div>
          <TaskComments taskId={task.id} user={user} focusCommentId={focusCommentId} />
          <div className="form-field form-field-wide ai-comment-field">
            <label htmlFor="detail-review-comment">Останній коментар для AI</label>
            <textarea
              id="detail-review-comment"
              rows={3}
              maxLength={5000}
              value={draft.reviewComment}
              onChange={(event) => setDraft({ ...draft, reviewComment: event.target.value })}
              placeholder="З’явиться після повторного запуску задачі"
            />
            <small>Новий коментар запитується окремо при статусі «Передивись ще раз».</small>
          </div>

          <div className="detail-control-grid">
            <div className="form-field">
              <label>Статус</label>
              <StatusSelect value={draft.status} onChange={(status) => setDraft({ ...draft, status })} />
            </div>
            <div className="form-field">
              <label htmlFor="detail-priority">Пріоритет</label>
              <div className="native-select">
                <select id="detail-priority" value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value as TaskPriority })}>
                  {priorityOrder.map((priority) => <option value={priority} key={priority}>{priorityMeta[priority].label}</option>)}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            <div className="form-field">
              <label htmlFor="detail-project">Проєкт</label>
              <div className="native-select">
                <select id="detail-project" value={draft.project} onChange={(event) => setDraft({ ...draft, project: event.target.value as TaskProject })}>
                  <option value="console">{projectMeta.console.label}</option>
                  <option value="ecommerce">{projectMeta.ecommerce.label}</option>
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
          </div>

          <AgentRunHistory task={task} />

          <div className="evidence-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Докази</span>
                <h3>{task.attachments.length ? mediaLabel(task.attachments.length) : 'Файлів ще немає'}</h3>
              </div>
              <button type="button" className="button button-small" onClick={() => inputRef.current?.click()} disabled={uploading}>
                {uploading ? <LoaderCircle className="spin" size={15} /> : <Paperclip size={15} />}
                Додати
              </button>
              <input ref={inputRef} hidden type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,image/avif,video/mp4,video/webm,video/quicktime" onChange={upload} />
            </div>
            {task.attachments.length > 0 ? (
              <div className="evidence-grid">
                {task.attachments.map((attachment) => (
                  <div className="evidence-card" key={attachment.id}>
                    <button
                      type="button"
                      className="evidence-image"
                      onClick={() => onOpenAttachment(attachment)}
                      aria-label={`Відкрити ${attachment.name}`}
                    >
                      {isVideo(attachment) ? (
                        <>
                          <video src={attachment.url} muted preload="metadata" playsInline />
                          <span className="video-play-badge"><Play size={17} fill="currentColor" /></span>
                        </>
                      ) : <img src={attachment.url} alt={attachment.name} />}
                    </button>
                    <div className="evidence-meta">
                      <span title={attachment.name}>{attachment.name}</span>
                      <button type="button" onClick={() => removeAttachment(attachment.id)} aria-label={`Видалити ${attachment.name}`}><Trash2 size={14} /></button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <button type="button" className="empty-evidence" onClick={() => inputRef.current?.click()}>
                <ImageIcon size={22} />
                <span>Додайте фото або відео помилки</span>
              </button>
            )}
          </div>

          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="dialog-actions edit-dialog-actions">
            <button type="button" className="delete-button" onClick={removeTask} disabled={saving}><Trash2 size={16} /> Видалити</button>
            <button className="button button-primary" type="submit" disabled={saving || draft.title.trim().length < 3}>
              {saving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
              {saving ? 'Зберігаю…' : 'Зберегти зміни'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}

function AgentRunHistory({ task }: { task: Task }) {
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void getTaskAgentRuns(task.id)
      .then((nextRuns) => {
        if (!cancelled) setRuns(nextRuns)
      })
      .catch((caughtError) => {
        if (!cancelled) setError(caughtError instanceof Error ? caughtError.message : 'Не вдалося завантажити історію.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [task.id, task.agentRun?.updatedAt, refreshKey])

  return (
    <section className="agent-history-section" aria-labelledby="agent-history-title">
      <div className="agent-history-heading">
        <div>
          <span className="eyebrow">AI</span>
          <h3 id="agent-history-title">Історія запусків <span>{runs.length}</span></h3>
        </div>
        <button
          type="button"
          className="icon-button agent-history-refresh"
          onClick={() => setRefreshKey((value) => value + 1)}
          disabled={loading}
          aria-label="Оновити історію AI-запусків"
        >
          {loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
        </button>
      </div>

      {error ? (
        <div className="agent-history-state is-error">{error}</div>
      ) : loading && runs.length === 0 ? (
        <div className="agent-history-state"><LoaderCircle className="spin" size={16} /> Завантажую запуски…</div>
      ) : runs.length === 0 ? (
        <div className="agent-history-state"><History size={17} /> Запусків ще немає.</div>
      ) : (
        <div className="agent-history-list">
          {runs.map((run) => {
            const comment = run.reviewComment || run.inputSnapshot?.reviewComment || ''
            const result = run.error || run.summary
            const snapshotAttachments = Array.isArray(run.inputSnapshot?.attachments)
              ? run.inputSnapshot.attachments.length
              : 0
            const snapshotProject = run.inputSnapshot
              ? projectMeta[run.inputSnapshot.project]?.label ?? run.inputSnapshot.project
              : ''
            return (
              <article className="agent-history-item" key={run.id}>
                <div className="agent-history-topline">
                  <div className="agent-history-attempt">
                    <strong>Спроба #{run.attempt}</strong>
                    <span>{run.trigger === 'review_again' ? 'Повторний перегляд' : 'Перший запуск'}</span>
                  </div>
                  <span className={`agent-history-status agent-run-${run.status}`}>
                    <i aria-hidden="true" /> {agentRunMeta[run.status].label}
                  </span>
                  <time dateTime={run.createdAt}>{formatDateTime(run.createdAt)}</time>
                </div>
                <p className={`agent-history-comment${comment ? '' : ' is-empty'}`}>
                  {comment || 'Первинний запуск без додаткового QA-коментаря.'}
                </p>
                {result && <p className={`agent-history-result${run.error ? ' is-error' : ''}`}>{result}</p>}
                <div className="agent-history-snapshot">
                  {run.inputSnapshot
                    ? `Snapshot: ${snapshotAttachments} вкладень · ${snapshotProject}`
                    : 'Legacy-запуск без snapshot даних'}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

type ReviewAgainRequest = {
  task: Task
  patch: Partial<TaskDraft>
}

function ReviewAgainDialog({
  request,
  onClose,
  onSubmit,
}: {
  request: ReviewAgainRequest
  onClose: () => void
  onSubmit: (comment: string, attachments: File[]) => Promise<void>
}) {
  const [comment, setComment] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [request, saving, onClose])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const normalizedComment = comment.trim()
    if (normalizedComment.length < 3) {
      setError('Опишіть, що саме залишилося невиправленим.')
      return
    }
    setSaving(true)
    setError('')
    try {
      await onSubmit(normalizedComment, files)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не вдалося запустити AI повторно.')
    } finally {
      setSaving(false)
    }
  }

  const nextAttempt = (request.task.agentRun?.attempt ?? 0) + 1

  return (
    <div className="modal-backdrop review-again-backdrop" onMouseDown={() => !saving && onClose()}>
      <section className="task-dialog review-again-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="review-again-title">
        <div className="dialog-header">
          <div>
            <span className="eyebrow">{request.task.id} · спроба #{nextAttempt}</span>
            <h2 id="review-again-title">Що саме не так?</h2>
          </div>
          <button className="icon-button" onClick={onClose} disabled={saving} aria-label="Закрити"><X size={19} /></button>
        </div>
        <form onSubmit={submit}>
          <div className="review-ai-context">
            <span><Bot size={18} /></span>
            <div>
              <strong>Новий запуск почнеться автоматично</strong>
              <p>AI отримає цей коментар разом з описом, URL, технічними нотатками та вкладеннями задачі.</p>
            </div>
          </div>
          <div className="form-field form-field-wide">
            <label htmlFor="review-comment">Коментар для AI <span>*</span></label>
            <div className="voice-textarea">
              <textarea
                id="review-comment"
                autoFocus
                required
                minLength={3}
                maxLength={5000}
                rows={6}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Наприклад: форма вже відкривається, але після натискання «Зберегти» все ще повертається 500. Перевір POST /api/orders…"
              />
              <VoiceInputButton
                onTranscript={(text) => setComment((current) => appendVoiceText(current, text, 5000))}
              />
            </div>
            <small className="field-counter">{comment.length} / 5000</small>
          </div>
          <div className="form-field form-field-wide">
            <label htmlFor="review-attachments">Нові докази для AI</label>
            <UploadZone files={files} onFiles={setFiles} inputId="review-attachments" />
          </div>
          {request.task.reviewComment && (
            <div className="previous-ai-comment">
              <span>Попередній коментар</span>
              <p>{request.task.reviewComment}</p>
            </div>
          )}
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>Скасувати</button>
            <button type="submit" className="button button-primary" disabled={saving || comment.trim().length < 3}>
              {saving ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
              {saving ? 'Ставлю в чергу…' : 'Запустити AI ще раз'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}

function Lightbox({ attachment, onClose }: { attachment: TaskAttachment | null; onClose: () => void }) {
  useEffect(() => {
    if (!attachment) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [attachment, onClose])

  if (!attachment) return null
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label={attachment.name}>
      <div className="lightbox-topbar">
        <span>{attachment.name}</span>
        <button onClick={onClose} aria-label="Закрити"><X size={20} /></button>
      </div>
      {isVideo(attachment) ? (
        <video
          src={attachment.url}
          controls
          autoPlay
          playsInline
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <img src={attachment.url} alt={attachment.name} onClick={(event) => event.stopPropagation()} />
      )}
    </div>
  )
}

function isSameDay(value: string) {
  const date = new Date(value)
  const now = new Date()
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
}

function parseRunDetails(run: AgentRun) {
  try {
    const parsed = JSON.parse(run.details || '{}') as {
      tests?: string[]
      changedFiles?: string[]
      reviewedAttachments?: string[]
    }
    return {
      tests: Array.isArray(parsed.tests) ? parsed.tests : [],
      changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles : [],
      reviewedAttachments: Array.isArray(parsed.reviewedAttachments) ? parsed.reviewedAttachments : [],
    }
  } catch {
    return { tests: [], changedFiles: [], reviewedAttachments: [] }
  }
}

function AgentConclusion({
  run,
  onOpenConclusion,
}: {
  run: AgentRun
  onOpenConclusion?: () => void
}) {
  const summary = (run.summary ?? '').trim()
  const error = (run.error ?? '').trim()
  if (!summary && !error) return null

  const { tests, changedFiles, reviewedAttachments } = parseRunDetails(run)

  return (
    <div
      className={`pipeline-conclusion pipeline-conclusion-${run.status}${onOpenConclusion ? ' is-clickable' : ''}`}
      role={onOpenConclusion ? 'button' : undefined}
      tabIndex={onOpenConclusion ? 0 : undefined}
      onClick={onOpenConclusion ? (event) => {
        event.stopPropagation()
        onOpenConclusion()
      } : undefined}
      onKeyDown={onOpenConclusion ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          onOpenConclusion()
        }
      } : undefined}
    >
      <span><Bot size={12} /> Висновок агента · {agentRunMeta[run.status].label}</span>
      <p className="pipeline-conclusion-text">{summary || error}</p>
      {changedFiles.length > 0 && (
        <div className="pipeline-conclusion-files">
          {changedFiles.slice(0, 6).map((file) => <code key={file}>{file.split('/').slice(-2).join('/')}</code>)}
          {changedFiles.length > 6 && <code>+{changedFiles.length - 6}</code>}
        </div>
      )}
      {tests.length > 0 && (
        <div className="pipeline-conclusion-tests">
          {tests.slice(0, 3).map((test) => <span key={test}>{test}</span>)}
        </div>
      )}
      {reviewedAttachments.length > 0 && (
        <div className="pipeline-conclusion-attachments">
          <Paperclip size={11} />
          <span>Переглянуто: {reviewedAttachments.slice(0, 3).join(', ')}</span>
          {reviewedAttachments.length > 3 && <span>+{reviewedAttachments.length - 3}</span>}
        </div>
      )}
      {onOpenConclusion && <span className="pipeline-conclusion-more">Показати повністю →</span>}
    </div>
  )
}

function AgentConclusionListDialog({
  open,
  tasks,
  onClose,
  onOpenConclusion,
}: {
  open: boolean
  tasks: Task[]
  onClose: () => void
  onOpenConclusion: (task: Task) => void
}) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const finished = tasks
    .filter((task) => task.agentRun && ['completed', 'needs_review', 'blocked', 'failed'].includes(task.agentRun.status))
    .sort((a, b) => Date.parse(b.agentRun!.finishedAt ?? b.agentRun!.updatedAt) - Date.parse(a.agentRun!.finishedAt ?? a.agentRun!.updatedAt))

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="task-dialog conclusion-list-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conclusion-list-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div>
            <span className="eyebrow">Конвеєр</span>
            <h2 id="conclusion-list-title">Висновки агента ({finished.length})</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Закрити"><X size={19} /></button>
        </div>

        <div className="conclusion-list-body">
          {finished.length ? finished.map((task) => (
            <button
              type="button"
              className={`conclusion-list-row conclusion-list-row-${task.agentRun!.status}`}
              key={`list-${task.id}`}
              onClick={() => onOpenConclusion(task)}
            >
              <span className="conclusion-list-head">
                <span className="task-id">{task.id}</span>
                <span className={`agent-table-state agent-run-${task.agentRun!.status}`}>
                  <Bot size={11} /> {agentRunMeta[task.agentRun!.status].shortLabel}
                </span>
                <span className="conclusion-list-project">{projectMeta[task.project ?? 'console'].label}</span>
              </span>
              <strong>{task.title}</strong>
              <span className="conclusion-list-summary">
                {(task.agentRun!.summary || task.agentRun!.error || '—').slice(0, 180)}
              </span>
            </button>
          )) : <p className="pipeline-empty">Ще немає завершених прогонів.</p>}
        </div>

        <div className="dialog-actions">
          <button className="button button-secondary" onClick={onClose}>Закрити</button>
        </div>
      </section>
    </div>
  )
}

function AgentConclusionDialog({
  task,
  onClose,
  onOpenTask,
}: {
  task: Task | null
  onClose: () => void
  onOpenTask: (taskId: string) => void
}) {
  useEffect(() => {
    if (!task) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [task, onClose])

  const run = task?.agentRun
  if (!task || !run) return null

  const { tests, changedFiles, reviewedAttachments } = parseRunDetails(run)
  const summary = (run.summary ?? '').trim()
  const error = (run.error ?? '').trim()

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="task-dialog conclusion-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conclusion-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div>
            <span className="eyebrow">{task.id} · спроба {run.attempt} · {agentRunMeta[run.status].label}</span>
            <h2 id="conclusion-title">{task.title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Закрити"><X size={19} /></button>
        </div>

        <div className="conclusion-body">
          {(task.reviewComment ?? '').trim() && (
            <section>
              <h4>Промпт повторного циклу</h4>
              <p className="conclusion-pre">{task.reviewComment}</p>
            </section>
          )}

          <section>
            <h4>Висновок агента</h4>
            <p className="conclusion-pre">{summary || '—'}</p>
          </section>

          {error && (
            <section>
              <h4>Помилка запуску</h4>
              <p className="conclusion-pre conclusion-error">{error}</p>
            </section>
          )}

          {changedFiles.length > 0 && (
            <section>
              <h4>Змінені файли ({changedFiles.length})</h4>
              <ul className="conclusion-list">
                {changedFiles.map((file) => <li key={file}><code>{file}</code></li>)}
              </ul>
            </section>
          )}

          {tests.length > 0 && (
            <section>
              <h4>Перевірки ({tests.length})</h4>
              <ul className="conclusion-list">
                {tests.map((test) => <li key={test}>{test}</li>)}
              </ul>
            </section>
          )}

          {reviewedAttachments.length > 0 && (
            <section>
              <h4>Переглянуті вкладення ({reviewedAttachments.length})</h4>
              <ul className="conclusion-list">
                {reviewedAttachments.map((attachment) => <li key={attachment}>{attachment}</li>)}
              </ul>
            </section>
          )}

          <section>
            <h4>Виконання</h4>
            <dl className="conclusion-meta">
              <div><dt>Гілка</dt><dd><code>{run.branch || '—'}</code></dd></div>
              <div><dt>Старт</dt><dd>{run.startedAt ? formatDateTime(run.startedAt) : '—'}</dd></div>
              <div><dt>Фініш</dt><dd>{run.finishedAt ? formatDateTime(run.finishedAt) : '—'}</dd></div>
              <div><dt>Тригер</dt><dd>{run.trigger === 'review_again' ? 'Передивись ще раз' : 'Створення задачі'}</dd></div>
            </dl>
          </section>
        </div>

        <div className="dialog-actions">
          <button className="button button-secondary" onClick={onClose}>Закрити</button>
          <button
            className="button button-primary"
            onClick={() => {
              onClose()
              onOpenTask(task.id)
            }}
          >
            Відкрити задачу
          </button>
        </div>
      </section>
    </div>
  )
}

function PipelineRunCard({
  task,
  onOpenTask,
  onOpenConclusion,
  onStop,
  variant = 'active',
}: {
  task: Task
  onOpenTask: (taskId: string) => void
  onOpenConclusion: (task: Task) => void
  onStop?: (taskId: string, revert: boolean) => void
  variant?: 'active' | 'retry'
}) {
  const [promptOpen, setPromptOpen] = useState(false)
  const run = task.agentRun
  if (!run) return null
  const isRerun = run.trigger === 'review_again' || run.attempt > 1
  const prompt = (task.reviewComment ?? '').trim()

  return (
    <button
      type="button"
      className={`pipeline-card pipeline-card-${variant}`}
      onClick={() => onOpenTask(task.id)}
    >
      <div className="pipeline-card-head">
        <span className="task-id">{task.id}</span>
        <span className={`agent-table-state agent-run-${run.status}`}>
          {run.status === 'running' ? <LoaderCircle className="spin" size={12} /> : <Bot size={12} />}
          {agentRunMeta[run.status].label}
        </span>
        {isRerun && <span className="pipeline-attempt">спроба {run.attempt}</span>}
      </div>
      <strong>{task.title}</strong>
      <div className="pipeline-card-meta">
        <span>{projectMeta[task.project ?? 'console'].label}</span>
        <span>{task.area}</span>
        {run.startedAt && <span>старт {formatDateTime(run.startedAt)}</span>}
        {run.branch && <span className="pipeline-branch">{run.branch}</span>}
      </div>
      {isRerun && (
        <div className="pipeline-prompt" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="pipeline-prompt-toggle"
            aria-expanded={promptOpen}
            onClick={() => setPromptOpen((open) => !open)}
          >
            <ChevronDown size={13} className={promptOpen ? 'pipeline-prompt-chevron-open' : undefined} />
            Промпт для повторного циклу
          </button>
          {promptOpen && (
            <p>{prompt || 'Без коментаря — Codex отримає лише статус «Передивись ще раз».'}</p>
          )}
        </div>
      )}
      <AgentConclusion run={run} onOpenConclusion={() => onOpenConclusion(task)} />
      {onStop && run.status === 'running' && (
        <div className="pipeline-card-controls" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="button button-small pipeline-action-stop"
            onClick={() => onStop(task.id, false)}
          ><Square size={13} /> Стоп</button>
          <button
            type="button"
            className="button button-small pipeline-action-revert"
            title="Зупинити і видалити worktree та гілку цієї спроби"
            onClick={() => {
              if (window.confirm(`Зупинити ${task.id} і повністю відкотити зміни Codex (worktree + гілка)?`)) {
                onStop(task.id, true)
              }
            }}
          ><Undo2 size={13} /> Стоп + відкат</button>
        </div>
      )}
    </button>
  )
}

function PipelineView({
  tasks,
  reorderingId,
  onOpenTask,
  onOpenConclusion,
  onReorder,
  onStop,
  onResume,
  onOpenConclusionList,
}: {
  tasks: Task[]
  reorderingId: string | null
  onOpenTask: (taskId: string) => void
  onOpenConclusion: (task: Task) => void
  onReorder: (taskId: string, direction: 'up' | 'down' | 'top') => void
  onStop: (taskId: string, revert: boolean) => void
  onResume: (taskId: string) => void
  onOpenConclusionList: () => void
}) {
  const running = tasks
    .filter((task) => task.agentRun?.status === 'running')
    .sort((a, b) => Date.parse(a.agentRun!.createdAt) - Date.parse(b.agentRun!.createdAt))
  const queued = tasks
    .filter((task) => task.agentRun?.status === 'queued')
    .sort((a, b) => {
      const byPriority = (b.agentRun!.queuePriority ?? 0) - (a.agentRun!.queuePriority ?? 0)
      return byPriority !== 0
        ? byPriority
        : Date.parse(a.agentRun!.createdAt) - Date.parse(b.agentRun!.createdAt)
    })
  const reruns = tasks.filter((task) => {
    const run = task.agentRun
    return run && (run.trigger === 'review_again' || run.attempt > 1) && (run.status === 'queued' || run.status === 'running')
  })
  const releasedToday = tasks.filter((task) => {
    const match = RELEASED_MARKER.exec(task.notes ?? '')
    return match && isSameDay(match[1].trim().replace(' ', 'T'))
  })
  const autoToday = tasks.filter((task) => isSentinelTask(task) && isSameDay(task.createdAt))
  const stopped = tasks.filter((task) => {
    const run = task.agentRun
    return run?.status === 'blocked' && /Зупинено оператором|Знято з черги оператором/.test(run.error ?? '')
  })
  const finished = tasks
    .filter((task) => {
      const run = task.agentRun
      return run && ['completed', 'needs_review', 'blocked', 'failed'].includes(run.status)
    })
    .sort((a, b) => Date.parse(b.agentRun!.finishedAt ?? b.agentRun!.updatedAt) - Date.parse(a.agentRun!.finishedAt ?? a.agentRun!.updatedAt))

  return (
    <div className="pipeline-view">
      <div className="pipeline-stats">
        <div className="pipeline-stat pipeline-stat-worker">
          <span>Codex-воркер</span>
          <strong>{running.length ? `працює: ${running.map((task) => task.id).join(', ')}` : 'очікує задач'}</strong>
        </div>
        <div className="pipeline-stat pipeline-stat-queue">
          <span>Черга</span>
          <strong>{queued.length}</strong>
        </div>
        <div className="pipeline-stat pipeline-stat-sentinel">
          <span>Вартовий логів</span>
          <strong>{autoToday.length} авто-задач сьогодні</strong>
        </div>
        <div className="pipeline-stat pipeline-stat-release">
          <span>Release-воркер</span>
          <strong>{releasedToday.length} випущено сьогодні</strong>
        </div>
      </div>

      <button
        type="button"
        className="pipeline-agent-data"
        disabled={finished.length === 0}
        onClick={onOpenConclusionList}
      >
        <Bot size={17} />
        <span>Показати дані агентів</span>
        <strong>{finished.length}</strong>
        <ChevronRight size={16} />
      </button>

      <section className="pipeline-section pipeline-section-running">
        <h3><LoaderCircle className={running.length ? 'spin' : ''} size={16} /> Зараз у роботі</h3>
        {running.length ? (
          <div className="pipeline-cards">
            {running.map((task) => (
              <PipelineRunCard
                key={task.id}
                task={task}
                onOpenTask={onOpenTask}
                onOpenConclusion={onOpenConclusion}
                onStop={onStop}
              />
            ))}
          </div>
        ) : <p className="pipeline-empty">Воркер вільний — черга порожня або обробка завершена.</p>}
      </section>

      <section className="pipeline-section pipeline-section-queue">
        <h3><Layers3 size={16} /> Черга ({queued.length})</h3>
        {queued.length ? (
          <div className="pipeline-queue pipeline-scroll">
            {queued.map((task, index) => (
              <div className="pipeline-queue-row" key={task.id}>
                <span className="pipeline-queue-position">{index + 1}</span>
                <button type="button" className="pipeline-queue-open" onClick={() => onOpenTask(task.id)}>
                  <span className="task-id">{task.id}</span>
                  <span className="pipeline-queue-title">{task.title}</span>
                  <span className="pipeline-queue-project">{projectMeta[task.project ?? 'console'].label}</span>
                  {(task.agentRun!.trigger === 'review_again' || task.agentRun!.attempt > 1) && (
                    <span className="pipeline-attempt">спроба {task.agentRun!.attempt}</span>
                  )}
                </button>
                <span className="pipeline-queue-actions">
                  <button
                    type="button"
                    title="У початок черги"
                    aria-label={`Підняти ${task.id} у початок черги`}
                    disabled={index === 0 || reorderingId === task.id}
                    onClick={() => onReorder(task.id, 'top')}
                  ><ChevronsUp size={15} /></button>
                  <button
                    type="button"
                    title="На позицію вище"
                    aria-label={`Підняти ${task.id} на позицію вище`}
                    disabled={index === 0 || reorderingId === task.id}
                    onClick={() => onReorder(task.id, 'up')}
                  ><ChevronUp size={15} /></button>
                  <button
                    type="button"
                    title="На позицію нижче"
                    aria-label={`Опустити ${task.id} на позицію нижче`}
                    disabled={index === queued.length - 1 || reorderingId === task.id}
                    onClick={() => onReorder(task.id, 'down')}
                  ><ChevronDown size={15} /></button>
                  <button
                    type="button"
                    className="pipeline-action-stop"
                    title="Зняти з черги"
                    aria-label={`Зняти ${task.id} з черги`}
                    onClick={() => onStop(task.id, false)}
                  ><Square size={13} /></button>
                </span>
              </div>
            ))}
          </div>
        ) : <p className="pipeline-empty">Черга порожня.</p>}
      </section>

      {reruns.length > 0 && (
        <section className="pipeline-section pipeline-section-retry">
          <h3><RefreshCw size={16} /> Повторні цикли з промптами</h3>
          <div className="pipeline-cards pipeline-scroll">
            {reruns.map((task) => (
              <PipelineRunCard
                key={`rerun-${task.id}`}
                task={task}
                variant="retry"
                onOpenTask={onOpenTask}
                onOpenConclusion={onOpenConclusion}
              />
            ))}
          </div>
        </section>
      )}

      {stopped.length > 0 && (
        <section className="pipeline-section pipeline-section-stopped">
          <h3><Square size={15} /> Зупинені ({stopped.length})</h3>
          <div className="pipeline-queue pipeline-scroll">
            {stopped.map((task) => (
              <div className="pipeline-queue-row" key={`stopped-${task.id}`}>
                <button type="button" className="pipeline-queue-open" onClick={() => onOpenTask(task.id)}>
                  <span className="task-id">{task.id}</span>
                  <span className="pipeline-queue-title">{task.title}</span>
                  <span className="pipeline-queue-project">{task.agentRun?.error || 'Зупинено'}</span>
                </button>
                <span className="pipeline-queue-actions">
                  <button
                    type="button"
                    className="button button-small pipeline-action-resume"
                    onClick={() => onResume(task.id)}
                  ><Play size={13} /> Резум</button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {releasedToday.length > 0 && (
        <section className="pipeline-section pipeline-section-released">
          <h3><Check size={16} /> Випущено на dev сьогодні</h3>
          <div className="pipeline-queue pipeline-scroll">
            {releasedToday.map((task) => (
              <button type="button" className="pipeline-queue-row pipeline-queue-row-plain" key={`released-${task.id}`} onClick={() => onOpenTask(task.id)}>
                <span className="task-id">{task.id}</span>
                <span className="pipeline-queue-title">{task.title}</span>
                <span className="pipeline-queue-project">{RELEASED_MARKER.exec(task.notes ?? '')?.[1]}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function CommentNotifications({
  onOpenComment,
}: {
  onOpenComment: (comment: UnreadTaskComment) => void
}) {
  const [summary, setSummary] = useState<UnreadComments>({ total: 0, comments: [] })
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [browserNotifications, setBrowserNotifications] = useState(
    () => 'Notification' in window && Notification.permission === 'granted',
  )
  const previousTotalRef = useRef<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    void getUnreadComments()
      .then((nextSummary) => {
        const previousTotal = previousTotalRef.current
        if (
          previousTotal !== null
          && nextSummary.total > previousTotal
          && 'Notification' in window
          && Notification.permission === 'granted'
          && document.hidden
        ) {
          const newest = nextSummary.comments[0]
          new Notification('Новий коментар у QA Desk', {
            body: newest ? `${newest.author} · ${newest.taskId}: ${newest.body}` : `${nextSummary.total} непрочитаних`,
          })
        }
        previousTotalRef.current = nextSummary.total
        setSummary(nextSummary)
        setError('')
      })
      .catch((caughtError) => setError(caughtError instanceof Error ? caughtError.message : 'Не вдалося завантажити коментарі.'))
      .finally(() => setLoading(false))
  }, [])

  const enableBrowserNotifications = async () => {
    const permission = await Notification.requestPermission()
    setBrowserNotifications(permission === 'granted')
  }

  useEffect(() => {
    refresh()
    const interval = window.setInterval(refresh, 10_000)
    window.addEventListener('qa-desk-comments-changed', refresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('qa-desk-comments-changed', refresh)
    }
  }, [refresh])

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [open])

  return (
    <div className="comment-notifications" ref={containerRef}>
      <button
        type="button"
        className={`notification-lamp${summary.total > 0 ? ' has-unread' : ''}`}
        onClick={() => {
          setOpen((current) => !current)
          refresh()
        }}
        aria-label={summary.total > 0 ? `Непрочитані коментарі: ${summary.total}` : 'Нових коментарів немає'}
        aria-expanded={open}
        title="Коментарі співробітників"
      >
        <Bell size={16} />
        {summary.total > 0 && <span>{summary.total > 99 ? '99+' : summary.total}</span>}
      </button>
      {open && (
        <section className="notification-popover" aria-label="Нові коментарі">
          <header>
            <div><span className="eyebrow">Команда</span><h3>Нові коментарі</h3></div>
            <span>{summary.total}</span>
          </header>
          <div className="notification-list">
            {loading ? (
              <div className="notification-state"><LoaderCircle className="spin" size={16} /> Завантажую…</div>
            ) : error ? (
              <button type="button" className="notification-state notification-retry" onClick={refresh}>{error}<strong>Повторити</strong></button>
            ) : summary.comments.length > 0 ? summary.comments.map((comment) => (
              <button
                type="button"
                className="notification-item"
                key={comment.id}
                onClick={() => {
                  setOpen(false)
                  onOpenComment(comment)
                }}
              >
                <span className="notification-avatar">{commentInitials(comment.author)}</span>
                <span className="notification-copy">
                  <span><strong>{comment.author}</strong><time dateTime={comment.createdAt}>{formatDateTime(comment.createdAt)}</time></span>
                  <b>{comment.taskId} · {comment.taskTitle}</b>
                  <small>{comment.body}</small>
                </span>
                <ChevronRight size={15} />
              </button>
            )) : (
              <div className="notification-state is-empty"><Check size={17} /> Нових коментарів немає</div>
            )}
          </div>
          {'Notification' in window && !browserNotifications && (
            <button
              type="button"
              className="enable-browser-notifications"
              onClick={() => void enableBrowserNotifications()}
            >
              <BellOff size={14} /> Увімкнути системні сповіщення
            </button>
          )}
        </section>
      )}
    </div>
  )
}

function DeskApp({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all')
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | 'all'>('all')
  const [sortDirection, setSortDirection] = useState<DateSortDirection>('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(pageSizeOptions[0])
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [commentFocus, setCommentFocus] = useState<{ taskId: string; commentId: string } | null>(null)
  const [lightboxAttachment, setLightboxAttachment] = useState<TaskAttachment | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [reviewAgainRequest, setReviewAgainRequest] = useState<ReviewAgainRequest | null>(null)
  const [toast, setToast] = useState('')
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('console')
  const [conclusionTask, setConclusionTask] = useState<Task | null>(null)
  const [reorderingId, setReorderingId] = useState<string | null>(null)
  const [, setControllingId] = useState<string | null>(null)
  const [connectionLost, setConnectionLost] = useState(false)
  const [conclusionListOpen, setConclusionListOpen] = useState(false)
  const [queueingId, setQueueingId] = useState<string | null>(null)

  const loadTasks = async () => {
    setLoading(true)
    setLoadError('')
    try {
      setTasks(await getTasks())
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Не вдалося завантажити задачі.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadTasks()
  }, [])

  const deepLinkAppliedRef = useRef(false)

  useEffect(() => {
    if (deepLinkAppliedRef.current || tasks.length === 0) return
    const parameters = new URLSearchParams(window.location.search)
    const requested = parameters.get('task')?.trim().toUpperCase()
    deepLinkAppliedRef.current = true
    if (!requested) return

    // Прибираємо ?task= одразу після використання: інакше він висить в адресі
    // назавжди — потрапляє в закладки, а кожне перезавантаження знову силоміць
    // відкриває ту саму задачу (навіть уже закриту, якої немає в таблиці).
    parameters.delete('task')
    const query = parameters.toString()
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)

    const target = tasks.find((task) => task.id.toUpperCase() === requested)
    if (!target) {
      setToast(`Задачу ${requested} не знайдено.`)
      return
    }

    setActiveTab(isSentinelTask(target) ? 'auto' : ((target.project ?? 'console') as WorkspaceTab))
    setSelectedId(target.id)
  }, [tasks])

  const hasActiveAgentRuns = tasks.some((task) => task.agentRun?.status === 'queued' || task.agentRun?.status === 'running')

  const knownStatusesRef = useRef<Map<string, TaskStatus> | null>(null)

  useEffect(() => {
    knownStatusesRef.current = new Map(tasks.map((task) => [task.id, task.status]))
  }, [tasks])

  const announceRemoteChanges = (nextTasks: Task[]) => {
    const known = knownStatusesRef.current
    if (!known) return

    const messages: string[] = []
    for (const task of nextTasks) {
      const previousStatus = known.get(task.id)
      if (previousStatus === undefined) {
        messages.push(`${task.id}: нова задача — ${task.title}`)
      } else if (previousStatus !== task.status) {
        messages.push(`${task.id}: ${statusMeta[task.status].label}`)
      }
    }
    if (messages.length === 0) return

    const summary = messages.length === 1 ? messages[0] : `${messages[0]} (+${messages.length - 1})`
    setToast(summary)
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      new Notification('GBA QA Desk', { body: messages.join('\n') })
    }
  }

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.hidden && !hasActiveAgentRuns) return
      void getTasks().then((nextTasks) => {
        announceRemoteChanges(nextTasks)
        setTasks(nextTasks)
        setConnectionLost(false)
      }).catch(() => setConnectionLost(true))
    }, hasActiveAgentRuns ? 2500 : 10000)
    return () => window.clearInterval(interval)
  }, [hasActiveAgentRuns])

  useEffect(() => {
    // Повернення вкладки або мережі — не чекаємо наступного тіку опитування.
    const refresh = () => {
      if (document.hidden) return
      void getTasks().then((nextTasks) => {
        announceRemoteChanges(nextTasks)
        setTasks(nextTasks)
        setConnectionLost(false)
      }).catch(() => setConnectionLost(true))
    }
    window.addEventListener('online', refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('online', refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(timeout)
  }, [toast])

  const selectedTask = tasks.find((task) => task.id === selectedId) ?? null

  const tabTasks = useMemo(() => {
    if (activeTab === 'pipeline') return tasks
    if (activeTab === 'auto') return tasks.filter(isSentinelTask)
    return tasks.filter((task) => (task.project ?? 'console') === activeTab && !isSentinelTask(task))
  }, [activeTab, tasks])

  const filteredTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('uk-UA')
    const filtered = tabTasks.filter((task) => {
      const matchesQuery = !normalizedQuery || [task.id, task.title, task.description, task.siteUrl, task.notes, task.staffComments, task.reviewComment, task.area]
        .some((value) => value.toLocaleLowerCase('uk-UA').includes(normalizedQuery))
      const matchesStatus = statusFilter === 'all' || task.status === statusFilter
      const matchesPriority = priorityFilter === 'all' || task.priority === priorityFilter
      // Закриті задачі не захаращують грід: їх видно лише коли їх явно просять
      // фільтром «Закрито» або шукають за номером/назвою.
      const hiddenAsDone = task.status === 'done' && statusFilter !== 'done' && !normalizedQuery
      return matchesQuery && matchesStatus && matchesPriority && !hiddenAsDone
    })

    return filtered.sort((firstTask, secondTask) => {
      const difference = Date.parse(firstTask.createdAt) - Date.parse(secondTask.createdAt)
      return sortDirection === 'asc' ? difference : -difference
    })
  }, [priorityFilter, query, sortDirection, statusFilter, tabTasks])

  const pageCount = Math.max(1, Math.ceil(filteredTasks.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const paginatedTasks = useMemo(() => {
    const offset = (currentPage - 1) * pageSize
    return filteredTasks.slice(offset, offset + pageSize)
  }, [currentPage, filteredTasks, pageSize])

  useEffect(() => {
    setPage(1)
  }, [activeTab, pageSize, priorityFilter, query, sortDirection, statusFilter])

  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  const reorderQueue = async (taskId: string, direction: 'up' | 'down' | 'top') => {
    setReorderingId(taskId)
    try {
      const updated = await reorderQueuedTask(taskId, direction)
      setTasks((current) => current.map((task) => task.id === updated.id ? updated : task))
      void getTasks().then(setTasks).catch(() => undefined)
      setToast(`${taskId}: черга оновлена`)
    } catch {
      setToast('Не вдалося змінити позицію в черзі')
    } finally {
      setReorderingId(null)
    }
  }

  const controlRun = async (taskId: string, action: 'stop' | 'stop-revert' | 'resume') => {
    setControllingId(taskId)
    try {
      const updated = action === 'resume'
        ? await resumeAgentRun(taskId)
        : await stopAgentRun(taskId, action === 'stop-revert')
      setTasks((current) => current.map((task) => task.id === updated.id ? updated : task))
      void getTasks().then(setTasks).catch(() => undefined)
      setToast(action === 'resume'
        ? `${taskId}: повернуто в чергу`
        : `${taskId}: зупинка${action === 'stop-revert' ? ' з відкатом' : ''} надіслана`)
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Не вдалося виконати дію')
    } finally {
      setControllingId(null)
    }
  }

  const enqueueTaskRun = async (task: Task) => {
    setQueueingId(task.id)
    try {
      const updated = await resumeAgentRun(task.id)
      setTasks((current) => current.map((item) => item.id === updated.id ? updated : item))
      void getTasks().then(setTasks).catch(() => undefined)
      setToast(`${task.id}: додано в чергу Codex`)
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Не вдалося поставити в чергу')
    } finally {
      setQueueingId(null)
    }
  }

  const replaceTask = (nextTask: Task) => {
    setTasks((current) => current.map((task) => task.id === nextTask.id ? nextTask : task))
  }

  const changeStatus = async (task: Task, status: TaskStatus) => {
    if (task.status === status) return
    if (status === 'review_again') {
      setReviewAgainRequest({ task, patch: { status } })
      return
    }
    const previousStatus = task.status
    setUpdatingId(task.id)
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status } : item))
    try {
      replaceTask(await updateTask(task.id, { status }))
      setToast(`${task.id}: статус оновлено`)
    } catch {
      setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: previousStatus } : item))
      setToast('Не вдалося оновити статус')
    } finally {
      setUpdatingId(null)
    }
  }

  const handleCreated = (task: Task) => {
    setTasks((current) => [task, ...current])
    setPage(1)
    setToast(`${task.id} створено`)
  }

  const submitReviewAgain = async (comment: string, attachments: File[]) => {
    if (!reviewAgainRequest) return
    const { task, patch } = reviewAgainRequest
    setUpdatingId(task.id)
    try {
      const updatedTask = await reviewTaskAgain(task.id, patch, comment, attachments)
      replaceTask(updatedTask)
      setReviewAgainRequest(null)
      setToast(`${task.id}: AI запущено повторно`)
    } finally {
      setUpdatingId(null)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="GBA QA Desk — на початок">
          <img className="brand-logo" src={gbaLogo} alt="GBA Assistant" />
          <strong>GBA QA Desk</strong>
        </a>
        <div className="topbar-meta">
          <CommentNotifications
            onOpenComment={(comment) => {
              setCommentFocus({ taskId: comment.taskId, commentId: comment.id })
              setSelectedId(comment.taskId)
            }}
          />
          <span className={`live-indicator${connectionLost ? ' live-indicator-offline' : ''}`}>
            <i /> {connectionLost ? 'Немає зв’язку — перепідключення…' : 'Система онлайн'}
          </span>
          <span className="topbar-date"><CalendarDays size={15} /> {formatDate(new Date().toISOString())}</span>
          <BuildTicker
            refreshKey={tasks.map((task) => `${task.id}:${task.status}:${task.updatedAt}`).join('|')}
            onOpenTask={setSelectedId}
            onBuildChanged={(buildNumber) => {
              setToast(`Задеплоєно новий build ${buildNumber}`)
              if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
                new Notification('GBA QA Desk', { body: `Задеплоєно новий build ${buildNumber}` })
              }
            }}
          />
          <div className="topbar-user" title={user.email}>
            <span className="topbar-user-avatar">{commentInitials(user.displayName)}</span>
            <span><strong>{user.displayName}</strong><small>{user.email}</small></span>
          </div>
          <button type="button" className="logout-button" onClick={onLogout} aria-label="Вийти з акаунта" title="Вийти з акаунта">
            <LogOut size={16} />
          </button>
        </div>
      </header>

      <main id="top">
        <section className="workspace">
          <nav className="project-tabs" aria-label="Проєкти">
            {workspaceTabs.map((tab) => {
              if (tab.key === 'architecture') {
                return (
                  <button
                    key={tab.key}
                    type="button"
                    className={`project-tab${activeTab === tab.key ? ' project-tab-active' : ''}`}
                    onClick={() => setActiveTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                )
              }
              // Лічильник має збігатися з тим, що реально видно в гріді, тож закриті не рахуємо.
              const open = tasks.filter((task) => task.status !== 'done')
              const count = tab.key === 'pipeline'
                ? tasks.filter((task) => task.agentRun?.status === 'queued' || task.agentRun?.status === 'running').length
                : tab.key === 'auto'
                  ? open.filter(isSentinelTask).length
                  : open.filter((task) => (task.project ?? 'console') === tab.key && !isSentinelTask(task)).length
              return (
                <button
                  key={tab.key}
                  type="button"
                  className={`project-tab${activeTab === tab.key ? ' project-tab-active' : ''}`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                  <span className="project-tab-count">{count}</span>
                </button>
              )
            })}
          </nav>
          {activeTab === 'architecture' ? (
            <ArchitectureView />
          ) : activeTab === 'pipeline' ? (
            loading ? (
              <div className="loading-state"><LoaderCircle className="spin" /><span>Завантажую конвеєр…</span></div>
            ) : (
              <PipelineView
                tasks={tasks}
                reorderingId={reorderingId}
                onOpenTask={setSelectedId}
                onOpenConclusion={setConclusionTask}
                onReorder={(taskId, direction) => void reorderQueue(taskId, direction)}
                onStop={(taskId, revert) => void controlRun(taskId, revert ? 'stop-revert' : 'stop')}
                onResume={(taskId) => void controlRun(taskId, 'resume')}
                onOpenConclusionList={() => setConclusionListOpen(true)}
              />
            )
          ) : (
          <>
          <div className="filters">
            <button className="button button-primary toolbar-create" onClick={() => setCreateOpen(true)}><Plus size={17} /> Нова задача</button>
            <label className="search-field">
              <Search size={18} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Пошук за номером, назвою, розділом…" aria-label="Пошук задач" />
              {query && <button onClick={() => setQuery('')} aria-label="Очистити пошук"><X size={15} /></button>}
            </label>
            <div className="filter-select">
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as TaskStatus | 'all')} aria-label="Фільтр за статусом">
                <option value="all">Усі статуси</option>
                {statusOrder.map((status) => <option value={status} key={status}>{statusMeta[status].label}</option>)}
              </select>
              <ChevronDown size={14} />
            </div>
            <div className="filter-select">
              <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as TaskPriority | 'all')} aria-label="Фільтр за пріоритетом">
                <option value="all">Усі пріоритети</option>
                {priorityOrder.map((priority) => <option value={priority} key={priority}>{priorityMeta[priority].label}</option>)}
              </select>
              <ChevronDown size={14} />
            </div>
            <div className="filter-select">
              <select value={sortDirection} onChange={(event) => setSortDirection(event.target.value as DateSortDirection)} aria-label="Сортування за датою створення">
                <option value="desc">Нові спочатку</option>
                <option value="asc">Старі спочатку</option>
              </select>
              <ChevronDown size={14} />
            </div>
          </div>

          {loading ? (
            <div className="loading-state"><LoaderCircle className="spin" /><span>Завантажую журнал…</span></div>
          ) : loadError ? (
            <div className="load-error"><strong>Не вдалося відкрити журнал</strong><span>{loadError}</span><button className="button button-secondary" onClick={() => void loadTasks()}><RefreshCw size={16} /> Спробувати ще</button></div>
          ) : filteredTasks.length ? (
            <TaskTable
              tasks={paginatedTasks}
              updatingId={updatingId}
              queueingId={queueingId}
              scrollable={activeTab === 'auto'}
              sortDirection={sortDirection}
              onOpenTask={(task) => setSelectedId(task.id)}
              onStatusChange={(task, status) => void changeStatus(task, status)}
              onSortDirectionChange={setSortDirection}
              onOpenAttachment={setLightboxAttachment}
              onEnqueue={(task) => void enqueueTaskRun(task)}
            />
          ) : <EmptyState onCreate={() => setCreateOpen(true)} />}

          {!loading && !loadError && filteredTasks.length > 0 && (
            <TaskPagination
              page={currentPage}
              pageCount={pageCount}
              pageSize={pageSize}
              filteredTotal={filteredTasks.length}
              total={tabTasks.length}
              onPageChange={(nextPage) => setPage(Math.min(Math.max(nextPage, 1), pageCount))}
              onPageSizeChange={setPageSize}
            />
          )}
          </>
          )}
        </section>
      </main>

      <CreateTaskDialog
        open={createOpen}
        project={activeTab === 'console' || activeTab === 'ecommerce' ? activeTab : 'console'}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
      <EditTaskDialog
        task={selectedTask}
        user={user}
        focusCommentId={commentFocus && commentFocus.taskId === selectedTask?.id ? commentFocus.commentId : null}
        onClose={() => {
          setSelectedId(null)
          setCommentFocus(null)
        }}
        onUpdated={(task) => {
          replaceTask(task)
          setToast(`${task.id} збережено`)
        }}
        onReviewAgain={(task, patch) => setReviewAgainRequest({ task, patch })}
        onDeleted={(id) => setTasks((current) => current.filter((task) => task.id !== id))}
        onOpenAttachment={setLightboxAttachment}
      />
      {reviewAgainRequest ? (
        <ReviewAgainDialog
          key={`${reviewAgainRequest.task.id}:${reviewAgainRequest.task.agentRun?.attempt ?? 0}`}
          request={reviewAgainRequest}
          onClose={() => setReviewAgainRequest(null)}
          onSubmit={submitReviewAgain}
        />
      ) : null}
      <AgentConclusionListDialog
        open={conclusionListOpen}
        tasks={tasks}
        onClose={() => setConclusionListOpen(false)}
        onOpenConclusion={(task) => {
          setConclusionListOpen(false)
          setConclusionTask(task)
        }}
      />
      <AgentConclusionDialog
        task={conclusionTask ? (tasks.find((item) => item.id === conclusionTask.id) ?? conclusionTask) : null}
        onClose={() => setConclusionTask(null)}
        onOpenTask={setSelectedId}
      />
      <Lightbox attachment={lightboxAttachment} onClose={() => setLightboxAttachment(null)} />
      {toast && <div className="toast"><Check size={15} /> {toast}</div>}
    </div>
  )
}

function LoginPage({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      onAuthenticated(await login(email, password))
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не вдалося увійти.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <img src={gbaLogo} alt="GBA Assistant" />
          <div><strong>GBA QA Desk</strong><span>Внутрішній простір команди</span></div>
        </div>
        <div className="login-heading">
          <span className="login-lock"><LockKeyhole size={20} /></span>
          <div>
            <h1 id="login-title">Вхід для співробітників</h1>
            <p>Увійдіть у свій персональний акаунт.</p>
          </div>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="login-email">Email</label>
          <div className="login-input-wrap">
            <UserRound size={17} aria-hidden="true" />
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@qa-desk.com"
            />
          </div>
          <label htmlFor="login-password">Пароль</label>
          <div className="login-input-wrap">
            <LockKeyhole size={17} aria-hidden="true" />
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Ваш пароль"
            />
          </div>
          {error && <div className="login-error" role="alert">{error}</div>}
          <button className="button button-primary login-submit" type="submit" disabled={saving || !email || !password}>
            {saving ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}
            {saving ? 'Входжу…' : 'Увійти'}
          </button>
        </form>
        <small className="login-security-note">Сесія захищена HttpOnly cookie. Коментарі підписуються вашим акаунтом.</small>
      </section>
    </main>
  )
}

function App() {
  const [user, setUser] = useState<AuthUser | null>()

  useEffect(() => {
    let cancelled = false
    void getCurrentUser()
      .then((currentUser) => {
        if (!cancelled) setUser(currentUser)
      })
      .catch(() => {
        if (!cancelled) setUser(null)
      })
    const requireAuthentication = () => setUser(null)
    window.addEventListener('qa-desk-auth-required', requireAuthentication)
    return () => {
      cancelled = true
      window.removeEventListener('qa-desk-auth-required', requireAuthentication)
    }
  }, [])

  if (user === undefined) {
    return <main className="auth-loading"><LoaderCircle className="spin" size={24} /><span>Перевіряю сесію…</span></main>
  }
  if (!user) return <LoginPage onAuthenticated={setUser} />

  return (
    <DeskApp
      user={user}
      onLogout={() => {
        void logout().finally(() => setUser(null))
      }}
    />
  )
}

export default App
