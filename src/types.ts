export type TaskStatus = 'new' | 'in_progress' | 'ready_for_retest' | 'review_again' | 'done' | 'blocked'
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical'
export type TaskProject = 'console' | 'ecommerce'
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'needs_review' | 'blocked' | 'failed'

export interface TaskAttachment {
  id: string
  name: string
  url: string
  type: string
  size: number
  kind: 'image' | 'video'
}

export interface AgentRunInputSnapshot {
  title: string
  description: string
  siteUrl: string
  notes: string
  reviewComment: string
  area: string
  project: TaskProject
  status: TaskStatus
  priority: TaskPriority
  attachments: TaskAttachment[]
}

export interface AgentRun {
  id: string
  taskId: string
  trigger: 'manual' | 'review_again'
  status: AgentRunStatus
  attempt: number
  reviewComment: string
  inputSnapshot: AgentRunInputSnapshot | null
  queuePriority: number
  control: string
  branch: string
  worktreePath: string
  summary: string
  details: string
  error: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string
}

export interface BuildBug {
  id: string
  title: string
  status: TaskStatus
  statusAtProcessing: TaskStatus
  priority: TaskPriority
  area: string
  processedAt: string
  source: 'manual' | 'codex'
}

export interface BuildInfo {
  number: string
  createdAt: string
  bugs: BuildBug[]
}

export interface Task {
  id: string
  title: string
  description: string
  siteUrl: string
  notes: string
  reviewComment: string
  area: string
  project: TaskProject
  status: TaskStatus
  priority: TaskPriority
  createdAt: string
  updatedAt: string
  attachments: TaskAttachment[]
  agentRun: AgentRun | null
}

export interface TaskDraft {
  title: string
  description: string
  siteUrl: string
  notes: string
  reviewComment: string
  area: string
  project: TaskProject
  status: TaskStatus
  priority: TaskPriority
}

export const projectMeta: Record<TaskProject, { label: string }> = {
  console: { label: 'GBA Console' },
  ecommerce: { label: 'Ecommerce' },
}

export const projectOrder: TaskProject[] = ['console', 'ecommerce']

export const statusMeta: Record<TaskStatus, { label: string; shortLabel: string }> = {
  new: { label: 'Новий', shortLabel: 'Новий' },
  in_progress: { label: 'У роботі', shortLabel: 'В роботі' },
  ready_for_retest: { label: 'Готовий до ретесту', shortLabel: 'Ретест' },
  review_again: { label: 'Передивись ще раз', shortLabel: 'Ще раз' },
  done: { label: 'Закрито', shortLabel: 'Готово' },
  blocked: { label: 'Заблоковано', shortLabel: 'Блок' },
}

export const priorityMeta: Record<TaskPriority, { label: string }> = {
  low: { label: 'Низький' },
  medium: { label: 'Середній' },
  high: { label: 'Високий' },
  critical: { label: 'Критичний' },
}
