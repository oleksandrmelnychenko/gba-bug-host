export type TaskStatus = 'new' | 'in_progress' | 'ready_for_retest' | 'review_again' | 'done' | 'blocked'
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical'
export type TaskProject = 'console' | 'ecommerce'
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'needs_review' | 'blocked' | 'failed'
export type ReleaseStatus = 'pending' | 'processing' | 'retrying' | 'waiting_mainline' | 'released' | 'blocked' | ''
export type ReleasePhase = 'queued' | 'preflight' | 'validating' | 'publishing' | 'migrating' | 'deploying' | 'verifying' | 'released' | 'failed' | ''

export interface TaskAttachment {
  id: string
  name: string
  url: string
  type: string
  size: number
  kind: 'image' | 'video' | 'document'
}

export interface TaskComment {
  id: string
  taskId: string
  parentId: string | null
  authorUserId: string | null
  author: string
  body: string
  createdAt: string
  updatedAt: string
}

export interface UnreadTaskComment extends TaskComment {
  taskTitle: string
}

export interface UnreadComments {
  total: number
  comments: UnreadTaskComment[]
}

export interface AuthUser {
  id: string
  email: string
  displayName: string
}

export interface AgentRunInputSnapshot {
  title: string
  description: string
  siteUrl: string
  notes: string
  staffComments: string
  reviewComment: string
  area: string
  project: TaskProject
  status: TaskStatus
  priority: TaskPriority
  attachments: TaskAttachment[]
  comments: TaskComment[]
}

export interface AgentRun {
  id: string
  taskId: string
  trigger: 'manual' | 'review_again'
  triggerReason?: '' | 'verification_failed' | 'auto_continue'
  sessionMode?: '' | 'fresh' | 'resume'
  sessionReason?: string
  codexModel?: string
  reasoningEffort?: string
  reasoningReason?: string
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
  releaseStatus: ReleaseStatus
  releaseAttempts: number
  releaseRepositories: string[]
  releaseError: string
  releasePhase: ReleasePhase
  releaseEvidence: Record<string, unknown>
  releasedAt: string | null
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
  pending: BuildBug[]
}

export interface TaskReadyBuild {
  number: string | null
  pending: boolean
  processedAt: string
  source: 'manual' | 'codex'
}

export interface Task {
  readyBuild?: TaskReadyBuild | null
  id: string
  title: string
  description: string
  siteUrl: string
  notes: string
  staffComments: string
  reviewComment: string
  area: string
  project: TaskProject
  status: TaskStatus
  qaStatus: string
  aiMode: TaskAiMode
  priority: TaskPriority
  createdByUserId: string | null
  createdByName: string
  entityKind: TaskEntityKind
  entityCode: string
  expectedResult: string
  actualResult: string
  intakeEvidence: IntakeEvidence
  createdAt: string
  updatedAt: string
  attachments: TaskAttachment[]
  agentRun: AgentRun | null
}

export type TaskAiMode = 'auto' | 'off'
export type TaskEntityKind = '' | 'client' | 'product' | 'document'

export interface IntakeEvidenceRequest {
  label: string
  path: string
  status: number | null
  ok: boolean
  itemCount: number | null
  items?: Record<string, unknown>[]
  error?: string
  proxyError?: string
  durationMs?: number
}

export interface IntakeEvidence {
  version?: number
  capturedAt?: string
  proxy?: string
  entity?: { kind: TaskEntityKind; code: string }
  requests?: IntakeEvidenceRequest[]
  truncated?: boolean
  error?: string
}

export interface TaskDraft {
  title: string
  description: string
  siteUrl: string
  notes: string
  staffComments: string
  reviewComment: string
  area: string
  project: TaskProject
  status: TaskStatus
  priority: TaskPriority
  aiMode: TaskAiMode
  entityKind: TaskEntityKind
  entityCode: string
  expectedResult: string
  actualResult: string
}

export type NodeStatus = 'ok' | 'warn' | 'down' | 'unknown'
export type NodeKind =
  | 'edge' | 'web' | 'api' | 'data' | 'sync' | 'ai' | 'worker' | 'unit'
  | 'scheduler' | 'timer' | 'oneshot' | 'domain' | 'dns' | 'net'

export interface TopologyGroup {
  key: string
  label: string
  hint?: string
}

export interface TopologyContainer {
  name: string
  image: string
  state: string
  status: string
  health: string
  project: string
  ports: string[]
}

export interface TopologySource {
  kind: 'docker' | 'probe' | 'systemd' | 'dns' | 'tls' | 'tcp'
  status: NodeStatus
  detail: string
  url?: string
  container?: TopologyContainer | null
}

export interface TopologyNode {
  id: string
  label: string
  group: string
  kind: NodeKind
  subtitle?: string
  note?: string
  container?: string
  probe?: string
  unit?: string
  units?: string[]
  configUrl?: string
  status: NodeStatus
  detail: string
  metrics: Record<string, unknown> | null
  config?: Record<string, unknown> | null
  configError?: string | null
  sources: TopologySource[]
}

export interface TopologyEdge {
  from: string
  to: string
  label?: string
}

export interface Topology {
  generatedAt: string
  environment?: string
  groups: TopologyGroup[]
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  summary: Record<NodeStatus, number>
  hostAgent: { receivedAt: string; ageSeconds: number; stale: boolean; host: string } | null
  dockerError: string | null
  overlay?: { applied: boolean; path: string; error: string | null }
}

export const nodeStatusMeta: Record<NodeStatus, { label: string }> = {
  ok: { label: 'Працює' },
  warn: { label: 'Увага' },
  down: { label: 'Не відповідає' },
  unknown: { label: 'Немає даних' },
}

export interface MetricsDistribution {
  count: number
  p50: number | null
  p90: number | null
}

export interface MetricsWeek {
  weekStart: string
  finishedRuns: number
  releasedRuns: number
  releaseRate: number | null
  timeToDeployP50: number | null
  timeToDeployP90: number | null
}

export interface MetricsFailureReason {
  reason: string
  count: number
  taskIds: string[]
}

export interface MetricsAlert {
  kind: 'main_red' | 'long_run' | 'usage_limit' | 'stale_task'
  taskId?: string
  taskIds?: string[]
  title?: string
  source?: string
  repo?: string
  sha?: string
  check?: string
  since?: string | null
  minutes?: number
  count?: number
  lastAt?: string | null
  pausedUntil?: string
  runStatus?: string
  releaseStatus?: string
}

export interface MetricsEvent {
  kind: string
  at: string | null
  detail: string
}

export interface MetricsTimelineStages {
  queuedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  gatesAt: string | null
  publishedAt: string | null
  deployedAt: string | null
  verifiedAt: string | null
  releasedAt: string | null
  waitingMainlineSince: string | null
}

export interface MetricsTimelineEntry {
  taskId: string
  title: string
  project: string
  taskStatus: string
  runId: string
  attempt: number
  trigger: string
  runStatus: string
  releaseStatus: string
  releasePhase: string
  outcome: string
  runsInWindow: number
  stages: MetricsTimelineStages
  durations: { queueWaitMs: number | null; codexMs: number | null; deployMs: number | null }
  events: MetricsEvent[]
}

export interface PipelineMetrics {
  generatedAt: string
  days: number
  since: string
  totals: {
    finishedRuns: number
    releasedRuns: number
    releaseRate: number | null
    timeToDeploy: MetricsDistribution
    codexDuration: MetricsDistribution
    queueWait: MetricsDistribution
  }
  weekly: MetricsWeek[]
  failureReasons: MetricsFailureReason[]
  alerts: MetricsAlert[]
  timeline: MetricsTimelineEntry[]
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
