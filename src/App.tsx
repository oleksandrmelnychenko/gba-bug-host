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
  Image as ImageIcon,
  Layers3,
  Link2,
  LoaderCircle,
  Paperclip,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from 'react'
import {
  addTaskAttachments,
  createTask,
  deleteTask,
  deleteTaskAttachment,
  getCurrentBuild,
  getTasks,
  updateTask,
} from './api'
import {
  priorityMeta,
  projectMeta,
  statusMeta,
  type AgentRunStatus,
  type BuildInfo,
  type Task,
  type TaskAttachment,
  type TaskDraft,
  type TaskPriority,
  type TaskProject,
  type TaskStatus,
} from './types'
import gbaLogo from './assets/brand/gba-logo.svg'

const emptyDraft: TaskDraft = {
  title: '',
  description: '',
  siteUrl: '',
  notes: '',
  reviewComment: '',
  area: '',
  project: 'console',
  status: 'new',
  priority: 'medium',
}

const statusOrder: TaskStatus[] = ['new', 'in_progress', 'review_again', 'ready_for_retest', 'blocked', 'done']
const priorityOrder: TaskPriority[] = ['critical', 'high', 'medium', 'low']
const pageSizeOptions = [10, 25, 50]

type DateSortDirection = 'desc' | 'asc'

type WorkspaceTab = TaskProject | 'auto'

const workspaceTabs: Array<{ key: WorkspaceTab; label: string }> = [
  { key: 'console', label: projectMeta.console.label },
  { key: 'ecommerce', label: projectMeta.ecommerce.label },
  { key: 'auto', label: 'Логи (авто)' },
]

function isSentinelTask(task: Task) {
  return (task.notes ?? '').includes('[sentinel:')
}

const COLUMN_WIDTHS_STORAGE_KEY = 'gba-qa-desk-column-widths-v2'
const tableColumns: Array<{ key: string; label: string; className?: string; srOnly?: boolean }> = [
  { key: 'title', label: 'Задача' },
  { key: 'created', label: 'Створено', className: 'column-created' },
  { key: 'area', label: 'Розділ' },
  { key: 'url', label: 'URL сторінки' },
  { key: 'notes', label: 'Нотатки' },
  { key: 'priority', label: 'Пріоритет' },
  { key: 'status', label: 'Статус' },
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
  return new Intl.DateTimeFormat('uk-UA', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value))
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
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

function BuildTicker({
  refreshKey,
  onOpenTask,
}: {
  refreshKey: string
  onOpenTask: (taskId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [build, setBuild] = useState<BuildInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const loadBuild = async () => {
    setLoading(true)
    setError('')
    try {
      setBuild(await getCurrentBuild())
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
          ) : build?.bugs.length ? (
            <div className="build-bug-list">
              {build.bugs.map((bug) => (
                <button
                  type="button"
                  className="build-bug-row"
                  key={bug.id}
                  onClick={() => {
                    onOpenTask(bug.id)
                    setOpen(false)
                  }}
                >
                  <span className="build-bug-id">{bug.id}</span>
                  <span className="build-bug-copy">
                    <strong>{bug.title}</strong>
                    <small>{bug.area} · {statusMeta[bug.statusAtProcessing].label}</small>
                  </span>
                  <span className={`build-source build-source-${bug.source}`}>{bug.source === 'codex' ? 'AI' : 'QA'}</span>
                </button>
              ))}
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
  sortDirection,
  onOpenTask,
  onStatusChange,
  onSortDirectionChange,
  onOpenAttachment,
}: {
  tasks: Task[]
  updatingId: string | null
  sortDirection: DateSortDirection
  onOpenTask: (task: Task) => void
  onStatusChange: (task: Task, status: TaskStatus) => void
  onSortDirectionChange: (direction: DateSortDirection) => void
  onOpenAttachment: (attachment: TaskAttachment) => void
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
      <div className="table-scroll">
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
                  <td onClick={(event) => event.stopPropagation()}>
                    <StatusSelect
                      value={task.status}
                      compact
                      disabled={updatingId === task.id}
                      onChange={(status) => onStatusChange(task, status)}
                    />
                  </td>
                  <td><AttachmentStack task={task} onOpen={onOpenAttachment} /></td>
                  <td onClick={(event) => event.stopPropagation()}>
                    <button className="row-arrow" onClick={() => onOpenTask(task)} aria-label={`Редагувати ${task.id}`} title="Редагувати"><Pencil size={15} /></button>
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
}: {
  files: File[]
  onFiles: (files: File[]) => void
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
            <textarea
              id="new-description"
              rows={4}
              maxLength={3000}
              value={draft.description}
              onChange={(event) => setField('description', event.target.value)}
              placeholder="Коротко опишіть кроки й очікуваний результат…"
            />
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

function EditTaskDialog({
  task,
  onClose,
  onUpdated,
  onReviewAgain,
  onDeleted,
  onOpenAttachment,
}: {
  task: Task | null
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
            <textarea id="detail-description" rows={5} maxLength={3000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
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

type ReviewAgainRequest = {
  task: Task
  patch: Partial<TaskDraft>
}

function ReviewAgainDialog({
  request,
  onClose,
  onSubmit,
}: {
  request: ReviewAgainRequest | null
  onClose: () => void
  onSubmit: (comment: string) => Promise<void>
}) {
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setComment('')
    setError('')
  }, [request?.task.id, request?.task.agentRun?.attempt])

  useEffect(() => {
    if (!request) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [request, saving, onClose])

  if (!request) return null

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
      await onSubmit(normalizedComment)
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
            <small className="field-counter">{comment.length} / 5000</small>
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

function App() {
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
  const [lightboxAttachment, setLightboxAttachment] = useState<TaskAttachment | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [reviewAgainRequest, setReviewAgainRequest] = useState<ReviewAgainRequest | null>(null)
  const [toast, setToast] = useState('')
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('console')
  const [notificationsReady, setNotificationsReady] = useState(
    () => 'Notification' in window && Notification.permission === 'granted',
  )

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
      }).catch(() => undefined)
    }, hasActiveAgentRuns ? 2500 : 10000)
    return () => window.clearInterval(interval)
  }, [hasActiveAgentRuns])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(timeout)
  }, [toast])

  const selectedTask = tasks.find((task) => task.id === selectedId) ?? null

  const tabTasks = useMemo(() => {
    if (activeTab === 'auto') return tasks.filter(isSentinelTask)
    return tasks.filter((task) => (task.project ?? 'console') === activeTab && !isSentinelTask(task))
  }, [activeTab, tasks])

  const filteredTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('uk-UA')
    const filtered = tabTasks.filter((task) => {
      const matchesQuery = !normalizedQuery || [task.id, task.title, task.description, task.siteUrl, task.notes, task.reviewComment, task.area]
        .some((value) => value.toLocaleLowerCase('uk-UA').includes(normalizedQuery))
      const matchesStatus = statusFilter === 'all' || task.status === statusFilter
      const matchesPriority = priorityFilter === 'all' || task.priority === priorityFilter
      return matchesQuery && matchesStatus && matchesPriority
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

  const submitReviewAgain = async (comment: string) => {
    if (!reviewAgainRequest) return
    const { task, patch } = reviewAgainRequest
    setUpdatingId(task.id)
    try {
      const updatedTask = await updateTask(task.id, {
        ...patch,
        status: 'review_again',
        reviewComment: comment,
      })
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
          {'Notification' in window && (
            <button
              type="button"
              className={`notify-toggle${notificationsReady ? ' notify-toggle-on' : ''}`}
              title={notificationsReady ? 'Браузерні сповіщення увімкнено' : 'Увімкнути браузерні сповіщення про зміни статусів'}
              onClick={() => {
                void Notification.requestPermission().then((permission) => setNotificationsReady(permission === 'granted'))
              }}
            >
              {notificationsReady ? <Bell size={15} /> : <BellOff size={15} />}
            </button>
          )}
          <span className="live-indicator"><i /> Система онлайн</span>
          <span className="topbar-date"><CalendarDays size={15} /> {formatDate(new Date().toISOString())}</span>
          <BuildTicker
            refreshKey={tasks.map((task) => `${task.id}:${task.status}:${task.updatedAt}`).join('|')}
            onOpenTask={setSelectedId}
          />
        </div>
      </header>

      <main id="top">
        <section className="workspace">
          <nav className="project-tabs" aria-label="Проєкти">
            {workspaceTabs.map((tab) => {
              const count = tab.key === 'auto'
                ? tasks.filter(isSentinelTask).length
                : tasks.filter((task) => (task.project ?? 'console') === tab.key && !isSentinelTask(task)).length
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
              sortDirection={sortDirection}
              onOpenTask={(task) => setSelectedId(task.id)}
              onStatusChange={(task, status) => void changeStatus(task, status)}
              onSortDirectionChange={setSortDirection}
              onOpenAttachment={setLightboxAttachment}
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
        </section>
      </main>

      <CreateTaskDialog
        open={createOpen}
        project={activeTab === 'auto' ? 'console' : activeTab}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
      <EditTaskDialog
        task={selectedTask}
        onClose={() => setSelectedId(null)}
        onUpdated={(task) => {
          replaceTask(task)
          setToast(`${task.id} збережено`)
        }}
        onReviewAgain={(task, patch) => setReviewAgainRequest({ task, patch })}
        onDeleted={(id) => setTasks((current) => current.filter((task) => task.id !== id))}
        onOpenAttachment={setLightboxAttachment}
      />
      <ReviewAgainDialog
        request={reviewAgainRequest}
        onClose={() => setReviewAgainRequest(null)}
        onSubmit={submitReviewAgain}
      />
      <Lightbox attachment={lightboxAttachment} onClose={() => setLightboxAttachment(null)} />
      {toast && <div className="toast"><Check size={15} /> {toast}</div>}
    </div>
  )
}

export default App
