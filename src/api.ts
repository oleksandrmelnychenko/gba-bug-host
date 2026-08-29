import type { AgentRun, AuthUser, BuildInfo, Task, TaskComment, TaskDraft, Topology, UnreadComments } from './types'

class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { credentials: 'same-origin', ...options })
  } catch {
    throw new ApiError('Не вдалося з’єднатися із сервером. Перевірте мережу та спробуйте ще раз.', 0)
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ message: 'Сталася помилка.' })) as { message?: string }
    if (response.status === 401 && url !== '/api/auth/login') {
      window.dispatchEvent(new Event('qa-desk-auth-required'))
    }
    throw new ApiError(payload.message ?? 'Сталася помилка.', response.status)
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function getTasks() {
  return request<Task[]>('/api/tasks')
}

export function getCurrentUser() {
  return request<AuthUser>('/api/auth/me')
}

export function login(email: string, password: string) {
  return request<AuthUser>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
}

export function logout() {
  return request<void>('/api/auth/logout', { method: 'POST' })
}

export function getCurrentBuild() {
  return request<BuildInfo>('/api/builds/current')
}

export function getTopology() {
  return request<Topology>('/api/topology')
}

export function getTaskAgentRuns(id: string) {
  return request<AgentRun[]>(`/api/tasks/${id}/agent-runs`)
}

export function getTaskComments(id: string) {
  return request<TaskComment[]>(`/api/tasks/${id}/comments`)
}

export function addTaskComment(id: string, comment: { body: string; parentId: string | null }) {
  return request<TaskComment>(`/api/tasks/${id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(comment),
  })
}

export function getUnreadComments() {
  return request<UnreadComments>('/api/comments/unread')
}

export function markTaskCommentsRead(id: string) {
  return request<UnreadComments>(`/api/tasks/${id}/comments/read`, { method: 'POST' })
}

function createTranscriptionBody(audio: Blob) {
  const mimeType = audio.type.split(';')[0] || 'audio/webm'
  const extension = mimeType.includes('mp4')
    ? 'm4a'
    : mimeType.includes('mpeg') || mimeType.includes('mp3')
      ? 'mp3'
      : mimeType.includes('wav')
        ? 'wav'
        : 'webm'
  const body = new FormData()
  body.append('audio', audio, `voice-${Date.now()}.${extension}`)
  return body
}

export async function transcribeAudio(audio: Blob) {
  const send = () => request<{ text: string }>('/api/transcriptions', {
    method: 'POST',
    body: createTranscriptionBody(audio),
  })

  try {
    return await send()
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 0) throw error
    return send()
  }
}

export function createTask(draft: TaskDraft, attachments: File[]) {
  const body = new FormData()
  for (const [key, value] of Object.entries(draft)) body.append(key, value)
  for (const attachment of attachments) body.append('attachments', attachment)
  return request<Task>('/api/tasks', { method: 'POST', body })
}

export function updateTask(id: string, patch: Partial<TaskDraft & Pick<Task, 'qaStatus'>>) {
  return request<Task>(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export function reviewTaskAgain(id: string, patch: Partial<TaskDraft>, reviewComment: string, attachments: File[]) {
  const body = new FormData()
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && key !== 'status' && key !== 'reviewComment') body.append(key, value)
  }
  body.append('reviewComment', reviewComment)
  for (const attachment of attachments) body.append('attachments', attachment)
  return request<Task>(`/api/tasks/${id}/review-again`, { method: 'POST', body })
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

export function reorderQueuedTask(id: string, direction: 'up' | 'down' | 'top') {
  return request<Task>(`/api/tasks/${id}/agent-runs/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction }),
  })
}

export function stopAgentRun(id: string, revert = false) {
  return request<Task>(`/api/tasks/${id}/agent-runs/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revert }),
  })
}

export function resumeAgentRun(id: string) {
  return request<Task>(`/api/tasks/${id}/agent-runs/resume`, { method: 'POST' })
}
