import { api } from './client'
import type {
  SftpEntry,
  TransferTask,
  ConflictResolution,
  SftpCreateSessionResponse,
  SftpListResponse,
  SftpTreeResponse,
  SftpTransferResponse,
  SftpUploadResponse,
  SftpDownloadResponse,
  SftpDeleteResponse,
  SftpFileReadResponse,
  SftpFileWriteRequest,
  SftpFileWriteResponse,
} from '@/types/sftp'

/** SFTP session info returned by GET /api/sftp/sessions/{id} */
export interface SftpSessionInfo {
  id: string
  profile_id: string
  status: string
  error?: string
  home_dir?: string // User's home directory
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

  list: (sessionId: string, path: string, showHidden = false) =>
    api.get<SftpListResponse>(
      `/api/sftp/sessions/${sessionId}/list?path=${encodeURIComponent(path)}&show_hidden=${showHidden}`
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

  /** Cross-session transfer: tries direct server-to-server copy first, falls
   *  back to backend relay if direct is not possible.
   *  If conflictResolution is "ask" (default) and the target has existing
   *  files, resolves with a `conflicts` array instead of starting a transfer.
   *  Pass "overwrite" | "rename" | "skip" to proceed without prompting. */
  transfer: async (
    sourceSessionId: string,
    targetSessionId: string,
    paths: string[],
    destDir: string,
    conflictResolution: ConflictResolution = 'ask',
  ): Promise<SftpTransferResponse> => {
    const res = await fetch('/api/sftp/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_session_id: sourceSessionId,
        target_session_id: targetSessionId,
        paths,
        dest_dir: destDir,
        conflict_resolution: conflictResolution,
      }),
    })
    const data = (await res.json().catch(() => ({}))) as SftpTransferResponse
    if (!res.ok && res.status !== 409) {
      const err = (data as unknown as { error?: { message?: string } })?.error
      throw new Error(err?.message || `transfer failed: ${res.statusText}`)
    }
    return data
  },

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

  // --- Built-in editor ---

  /** Read a remote file as text for editing. Backend guards: >10MB → 413,
   *  binary → 415, non-UTF-8 → 415. Returns content + optimistic-lock token
   *  (mod_time) + Monaco language hint. */
  readFile: (sessionId: string, path: string) =>
    api.get<SftpFileReadResponse>(
      `/api/sftp/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`
    ),

  /** Write edited content back. Uses optimistic locking via expected_mod_time;
   *  mismatch → 409 FILE_MODIFIED. Returns the new mod_time for the next save. */
  writeFile: (sessionId: string, path: string, body: SftpFileWriteRequest) =>
    api.put<SftpFileWriteResponse>(
      `/api/sftp/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`,
      body
    ),
}
