import type { AgentRun, BuildInfo, Task, TaskDraft } from './types'

class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ message: 'Сталася помилка.' })) as { message?: string }
    throw new ApiError(payload.message ?? 'Сталася помилка.', response.status)
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function getTasks() {
  return request<Task[]>('/api/tasks')
}

export function getCurrentBuild() {
  return request<BuildInfo>('/api/builds/current')
}

export function getTaskAgentRuns(id: string) {
  return request<AgentRun[]>(`/api/tasks/${id}/agent-runs`)
}

export function createTask(draft: TaskDraft, attachments: File[]) {
  const body = new FormData()
  for (const [key, value] of Object.entries(draft)) body.append(key, value)
  for (const attachment of attachments) body.append('attachments', attachment)
  return request<Task>('/api/tasks', { method: 'POST', body })
}

export function updateTask(id: string, patch: Partial<TaskDraft>) {
  return request<Task>(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export function addTaskAttachments(id: string, attachments: File[]) {
  const body = new FormData()
  for (const attachment of attachments) body.append('attachments', attachment)
  return request<Task>(`/api/tasks/${id}/attachments`, { method: 'POST', body })
}

export function deleteTaskAttachment(taskId: string, attachmentId: string) {
  return request<Task>(`/api/tasks/${taskId}/attachments/${attachmentId}`, { method: 'DELETE' })
}

export function deleteTask(id: string) {
  return request<void>(`/api/tasks/${id}`, { method: 'DELETE' })
}
