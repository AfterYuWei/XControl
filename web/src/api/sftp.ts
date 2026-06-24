import { api } from './client'
import type {
  SftpEntry,
  TransferTask,
  SftpCreateSessionResponse,
  SftpListResponse,
  SftpTreeResponse,
  SftpUploadResponse,
  SftpDownloadResponse,
  SftpDeleteResponse,
} from '@/types/sftp'

/** SFTP session info returned by GET /api/sftp/sessions/{id} */
export interface SftpSessionInfo {
  id: string
  profile_id: string
  status: string
  error?: string
  created_at: string
}

export const sftpApi = {
  // --- Session management ---

  createSession: (profileId: string) =>
    api.post<SftpCreateSessionResponse>('/api/sftp/sessions', { profile_id: profileId }),

  getSession: (id: string) =>
    api.get<SftpSessionInfo>(`/api/sftp/sessions/${id}`),

  listSessions: () =>
    api.get<SftpSessionInfo[]>('/api/sftp/sessions'),

  closeSession: (id: string) =>
    api.delete<void>(`/api/sftp/sessions/${id}`),

  // --- File operations ---

  list: (sessionId: string, path: string) =>
    api.get<SftpListResponse>(
      `/api/sftp/sessions/${sessionId}/list?path=${encodeURIComponent(path)}`
    ),

  stat: (sessionId: string, path: string) =>
    api.get<SftpEntry>(
      `/api/sftp/sessions/${sessionId}/stat?path=${encodeURIComponent(path)}`
    ),

  tree: (sessionId: string, path: string, depth = 3) =>
    api.get<SftpTreeResponse>(
      `/api/sftp/sessions/${sessionId}/tree?path=${encodeURIComponent(path)}&depth=${depth}`
    ),

  mkdir: (sessionId: string, path: string) =>
    api.post<SftpEntry>(`/api/sftp/sessions/${sessionId}/mkdir`, { path }),

  rename: (sessionId: string, oldPath: string, newPath: string) =>
    api.post<SftpEntry>(`/api/sftp/sessions/${sessionId}/rename`, {
      old_path: oldPath,
      new_path: newPath,
    }),

  delete: (sessionId: string, paths: string[]) =>
    api.post<SftpDeleteResponse>(`/api/sftp/sessions/${sessionId}/delete`, { paths }),

  // --- Transfers ---

  /** Upload files via multipart form. Each file in the array becomes a separate
   *  transfer task on the backend. */
  upload: (sessionId: string, files: File[], destDir: string, overwrite = false) => {
    const formData = new FormData()
    for (const file of files) {
      formData.append('file', file)
    }
    formData.append('dest_dir', destDir)
    formData.append('overwrite', String(overwrite))
    return fetch(`/api/sftp/sessions/${sessionId}/upload`, {
      method: 'POST',
      body: formData,
    }).then(async (res) => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { code: 'UNKNOWN', message: res.statusText } }))
        throw err
      }
      return res.json() as Promise<SftpUploadResponse>
    })
  },

  /** Download files from the remote server. Returns tasks + a download URL
   *  template. When tasks complete, fetch the download_url to retrieve the
   *  file (single) or zip (multiple). */
  download: (sessionId: string, paths: string[]) =>
    api.post<SftpDownloadResponse>(`/api/sftp/sessions/${sessionId}/download`, { paths }),

  /** Fetch the downloaded file blob. Call after the task status is "completed". */
  fetchDownloadFile: (taskId: string) =>
    fetch(`/api/sftp/transfers/${taskId}/file`).then((res) => {
      if (!res.ok) throw new Error(`download failed: ${res.statusText}`)
      return res.blob()
    }),

  listTransfers: (sessionId?: string, status?: string) => {
    const params = new URLSearchParams()
    if (sessionId) params.set('session_id', sessionId)
    if (status) params.set('status', status)
    const q = params.toString()
    return api.get<TransferTask[]>(`/api/sftp/transfers${q ? `?${q}` : ''}`)
  },

  cancelTransfer: (taskId: string) =>
    api.delete<{ id: string; status: string }>(`/api/sftp/transfers/${taskId}`),

  clearCompletedTransfers: () =>
    api.delete<void>('/api/sftp/transfers?status=completed'),
}
