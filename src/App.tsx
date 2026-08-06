import {
  Bell,
  BellOff,
  Bot,
  Bug,
  CalendarDays,
  Check,
  ChevronDown,
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
  projectOrder,
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
  area: '',
  project: 'console',
  status: 'new',
  priority: 'medium',
}

const statusOrder: TaskStatus[] = ['new', 'in_progress', 'review_again', 'ready_for_retest', 'blocked', 'done']
const priorityOrder: TaskPriority[] = ['critical', 'high', 'medium', 'low']

const COLUMN_WIDTHS_STORAGE_KEY = 'gba-qa-desk-column-widths'
const tableColumns: Array<{ key: string; label: string; className?: string; srOnly?: boolean }> = [
  { key: 'id', label: 'Номер', className: 'column-id' },
  { key: 'title', label: 'Задача' },
  { key: 'area', label: 'Розділ' },
  { key: 'url', label: 'URL сайту' },
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
        <span>BUILD</span>
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
  onOpenTask,
  onStatusChange,
  onQuickSave,
  onOpenAttachment,
}: {
  tasks: Task[]
  updatingId: string | null
  onOpenTask: (task: Task) => void
  onStatusChange: (task: Task, status: TaskStatus) => void
  onQuickSave: (task: Task, draft: TaskDraft) => Promise<void>
  onOpenAttachment: (attachment: TaskAttachment) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<TaskDraft>(emptyDraft)
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState('')
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

  const beginEdit = (task: Task) => {
    setEditingId(task.id)
    setEditDraft(taskToDraft(task))
    setEditError('')
  }

  const setEditField = <Key extends keyof TaskDraft>(key: Key, value: TaskDraft[Key]) => {
    setEditDraft((current) => ({ ...current, [key]: value }))
  }

  const cancelEdit = () => {
    if (savingEdit) return
    setEditingId(null)
    setEditError('')
  }

  const saveEdit = async (task: Task) => {
    if (editDraft.title.trim().length < 3) {
      setEditError('Назва має містити щонайменше 3 символи.')
      return
    }
    setSavingEdit(true)
    setEditError('')
    try {
      await onQuickSave(task, editDraft)
      setEditingId(null)
    } catch (caughtError) {
      setEditError(caughtError instanceof Error ? caughtError.message : 'Не вдалося зберегти зміни.')
    } finally {
      setSavingEdit(false)
    }
  }

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
                  {column.srOnly ? <span className="sr-only">{column.label}</span> : column.label}
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
            {tasks.map((task, index) => {
              const isEditing = editingId === task.id
              return (
                <tr
                  key={task.id}
                  className={isEditing ? 'editing-row' : undefined}
                  onClick={isEditing ? undefined : () => onOpenTask(task)}
                  onKeyDown={isEditing ? (event) => {
                    if (event.key === 'Escape') cancelEdit()
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void saveEdit(task)
                  } : undefined}
                  style={{ '--row-delay': `${Math.min(index, 7) * 35}ms` } as React.CSSProperties}
                >
                  <td>
                    <span className="task-id">{task.id}</span>
                    {task.agentRun && (
                      <span className={`agent-table-state agent-run-${task.agentRun.status}`} title={agentRunMeta[task.agentRun.status].label}>
                        {task.agentRun.status === 'running'
                          ? <LoaderCircle className="spin" size={11} />
                          : <Bot size={11} />} {agentRunMeta[task.agentRun.status].shortLabel}
                      </span>
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <div className="quick-title-fields">
                        <input
                          className="table-edit-input"
                          autoFocus
                          required
                          minLength={3}
                          maxLength={140}
                          value={editDraft.title}
                          onChange={(event) => setEditField('title', event.target.value)}
                          aria-label="Назва задачі"
                        />
                        <textarea
                          className="table-edit-input"
                          rows={2}
                          maxLength={3000}
                          value={editDraft.description}
                          onChange={(event) => setEditField('description', event.target.value)}
                          aria-label="Опис задачі"
                          placeholder="Опис"
                        />
                        {editError && <span className="quick-edit-error" role="alert">{editError}</span>}
                      </div>
                    ) : (
                      <div className="task-title-cell">
                        <strong>{task.title}</strong>
                        <span>{task.description || 'Без додаткового опису'}</span>
                      </div>
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <input className="table-edit-input" maxLength={80} value={editDraft.area} onChange={(event) => setEditField('area', event.target.value)} aria-label="Розділ" />
                    ) : <span className="area-label">{task.area}</span>}
                  </td>
                  <td>
                    {isEditing ? (
                      <input className="table-edit-input table-edit-mono" inputMode="url" maxLength={2048} value={editDraft.siteUrl} onChange={(event) => setEditField('siteUrl', event.target.value)} aria-label="URL сайту" placeholder="https://…" />
                    ) : task.siteUrl ? (
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
                  <td>
                    {isEditing ? (
                      <textarea className="table-edit-input table-edit-mono" rows={3} maxLength={10000} value={editDraft.notes} onChange={(event) => setEditField('notes', event.target.value)} aria-label="Нотатки" placeholder="HTTP request…" />
                    ) : <span className="notes-cell" title={task.notes}>{task.notes || '—'}</span>}
                  </td>
                  <td>
                    {isEditing ? (
                      <select className="table-edit-input table-edit-select" value={editDraft.priority} onChange={(event) => setEditField('priority', event.target.value as TaskPriority)} aria-label="Пріоритет">
                        {priorityOrder.map((priority) => <option value={priority} key={priority}>{priorityMeta[priority].label}</option>)}
                      </select>
                    ) : <PriorityBadge priority={task.priority} />}
                  </td>
                  <td onClick={(event) => event.stopPropagation()}>
                    {isEditing ? (
                      <select className="table-edit-input table-edit-select" value={editDraft.status} onChange={(event) => setEditField('status', event.target.value as TaskStatus)} aria-label="Статус">
                        {statusOrder.map((status) => <option value={status} key={status}>{statusMeta[status].label}</option>)}
                      </select>
                    ) : (
                      <StatusSelect
                        value={task.status}
                        compact
                        disabled={updatingId === task.id}
                        onChange={(status) => onStatusChange(task, status)}
                      />
                    )}
                  </td>
                  <td><AttachmentStack task={task} onOpen={onOpenAttachment} /></td>
                  <td onClick={(event) => event.stopPropagation()}>
                    {isEditing ? (
                      <div className="quick-edit-actions">
                        <button className="quick-edit-save" onClick={() => void saveEdit(task)} disabled={savingEdit} aria-label={`Зберегти ${task.id}`}>
                          {savingEdit ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
                        </button>
                        <button className="quick-edit-cancel" onClick={cancelEdit} disabled={savingEdit} aria-label="Скасувати редагування"><X size={15} /></button>
                      </div>
                    ) : (
                      <button className="row-arrow" onClick={() => beginEdit(task)} aria-label={`Швидко редагувати ${task.id}`} title="Швидке редагування"><Pencil size={15} /></button>
                    )}
                  </td>
                </tr>
              )
            })}
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
      <section className="create-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="create-title">
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
          <div className="form-field form-field-wide">
            <label htmlFor="new-site-url">URL сайту</label>
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
              <label htmlFor="new-area">Розділ</label>
              <input id="new-area" maxLength={80} value={draft.area} onChange={(event) => setField('area', event.target.value)} placeholder="Продажі" />
            </div>
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

function TaskDetailDrawer({
  task,
  onClose,
  onUpdated,
  onDeleted,
  onOpenAttachment,
}: {
  task: Task | null
  onClose: () => void
  onUpdated: (task: Task) => void
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
  }, [task?.id])

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
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="task-drawer" onMouseDown={(event) => event.stopPropagation()} aria-labelledby="task-drawer-title">
        <div className="drawer-head">
          <div>
            <span className="task-id">{task.id}</span>
            <span className="updated-at">Оновлено {formatDate(task.updatedAt)}</span>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Закрити"><X size={19} /></button>
        </div>

        <form onSubmit={save} className="drawer-form">
          <div className="form-field form-field-wide">
            <label htmlFor="detail-title">Назва</label>
            <input id="detail-title" required minLength={3} maxLength={140} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </div>
          <div className="form-field form-field-wide">
            <label htmlFor="detail-description">Опис</label>
            <textarea id="detail-description" rows={5} maxLength={3000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
          </div>
          <div className="form-field form-field-wide">
            <label htmlFor="detail-site-url">URL сайту</label>
            <input id="detail-site-url" type="text" inputMode="url" maxLength={2048} value={draft.siteUrl} onChange={(event) => setDraft({ ...draft, siteUrl: event.target.value })} placeholder="https://example.com/problem-page" />
          </div>
          <div className="form-field form-field-wide">
            <label htmlFor="detail-notes">Нотатки</label>
            <textarea id="detail-notes" className="technical-notes" rows={5} maxLength={10000} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="HTTP request, payload, response — без паролів і токенів" />
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
              <label htmlFor="detail-area">Розділ</label>
              <input id="detail-area" maxLength={80} value={draft.area} onChange={(event) => setDraft({ ...draft, area: event.target.value })} />
            </div>
            <div className="form-field">
              <label htmlFor="detail-project">Проєкт</label>
              <div className="native-select">
                <select id="detail-project" value={draft.project} onChange={(event) => setDraft({ ...draft, project: event.target.value as TaskProject })}>
                  {projectOrder.map((item) => <option value={item} key={item}>{projectMeta[item].label}</option>)}
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
          <div className="drawer-actions">
            <button type="button" className="delete-button" onClick={removeTask} disabled={saving}><Trash2 size={16} /> Видалити</button>
            <button className="button button-primary" type="submit" disabled={saving || draft.title.trim().length < 3}>
              {saving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
              {saving ? 'Зберігаю…' : 'Зберегти зміни'}
            </button>
          </div>
        </form>
      </aside>
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
  const [project, setProject] = useState<TaskProject>('console')
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all')
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | 'all'>('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [lightboxAttachment, setLightboxAttachment] = useState<TaskAttachment | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [toast, setToast] = useState('')
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

  const projectTasks = useMemo(
    () => tasks.filter((task) => (task.project ?? 'console') === project),
    [project, tasks],
  )

  const filteredTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('uk-UA')
    return projectTasks.filter((task) => {
      const matchesQuery = !normalizedQuery || [task.id, task.title, task.description, task.siteUrl, task.notes, task.area]
        .some((value) => value.toLocaleLowerCase('uk-UA').includes(normalizedQuery))
      const matchesStatus = statusFilter === 'all' || task.status === statusFilter
      const matchesPriority = priorityFilter === 'all' || task.priority === priorityFilter
      return matchesQuery && matchesStatus && matchesPriority
    })
  }, [priorityFilter, projectTasks, query, statusFilter])

  const replaceTask = (nextTask: Task) => {
    setTasks((current) => current.map((task) => task.id === nextTask.id ? nextTask : task))
  }

  const changeStatus = async (task: Task, status: TaskStatus) => {
    if (task.status === status) return
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

  const quickSave = async (task: Task, draft: TaskDraft) => {
    setUpdatingId(task.id)
    try {
      replaceTask(await updateTask(task.id, draft))
      setToast(`${task.id}: зміни збережено`)
    } catch (caughtError) {
      setToast('Не вдалося зберегти зміни')
      throw caughtError
    } finally {
      setUpdatingId(null)
    }
  }

  const handleCreated = (task: Task) => {
    setTasks((current) => [task, ...current])
    setToast(`${task.id} створено`)
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
        </div>
      </header>

      <main id="top">
        <section className="workspace">
          <nav className="project-tabs" aria-label="Проєкти">
            {projectOrder.map((item) => {
              const count = tasks.filter((task) => (task.project ?? 'console') === item).length
              return (
                <button
                  key={item}
                  type="button"
                  className={`project-tab${project === item ? ' project-tab-active' : ''}`}
                  onClick={() => setProject(item)}
                >
                  {projectMeta[item].label}
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
          </div>

          {loading ? (
            <div className="loading-state"><LoaderCircle className="spin" /><span>Завантажую журнал…</span></div>
          ) : loadError ? (
            <div className="load-error"><strong>Не вдалося відкрити журнал</strong><span>{loadError}</span><button className="button button-secondary" onClick={() => void loadTasks()}><RefreshCw size={16} /> Спробувати ще</button></div>
          ) : filteredTasks.length ? (
            <TaskTable
              tasks={filteredTasks}
              updatingId={updatingId}
              onOpenTask={(task) => setSelectedId(task.id)}
              onStatusChange={(task, status) => void changeStatus(task, status)}
              onQuickSave={quickSave}
              onOpenAttachment={setLightboxAttachment}
            />
          ) : <EmptyState onCreate={() => setCreateOpen(true)} />}

          {!loading && !loadError && filteredTasks.length > 0 && (
            <div className="table-footer">
              <span>Показано {filteredTasks.length} із {projectTasks.length} · {projectMeta[project].label}</span>
              <span><i /> Зміни зберігаються автоматично</span>
            </div>
          )}
        </section>
      </main>

      <footer className="footer">
        <span>GBA QA DESK · 2026</span>
        <BuildTicker
          refreshKey={tasks.map((task) => `${task.id}:${task.status}:${task.updatedAt}`).join('|')}
          onOpenTask={setSelectedId}
        />
      </footer>

      <CreateTaskDialog open={createOpen} project={project} onClose={() => setCreateOpen(false)} onCreated={handleCreated} />
      <TaskDetailDrawer
        task={selectedTask}
        onClose={() => setSelectedId(null)}
        onUpdated={(task) => {
          replaceTask(task)
          setToast(`${task.id} збережено`)
        }}
        onDeleted={(id) => setTasks((current) => current.filter((task) => task.id !== id))}
        onOpenAttachment={setLightboxAttachment}
      />
      <Lightbox attachment={lightboxAttachment} onClose={() => setLightboxAttachment(null)} />
      {toast && <div className="toast"><Check size={15} /> {toast}</div>}
    </div>
  )
}

export default App
