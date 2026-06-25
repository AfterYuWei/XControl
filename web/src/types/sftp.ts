/** SFTP file entry — mirrors backend model/sftp.go SftpEntry.
 *  Field names use snake_case to match the backend contract. */
export interface SftpEntry {
  name: string
  /** Absolute POSIX path (without trailing slash). */
  path: string
  is_dir: boolean
  size: number // bytes; 0 for directories
  mod_time: string // RFC 3339 timestamp
  /** Unix permission hint, e.g. "rwxr-xr-x". Optional. */
  mode?: string
}

/** Tree node for recursive tree endpoint responses. */
export interface SftpTreeNode extends SftpEntry {
  children?: SftpTreeNode[]
}

export type TransferDirection = 'upload' | 'download'
export type TransferStatus = 'queued' | 'transferring' | 'completed' | 'failed' | 'cancelled'

export interface TransferTask {
  id: string
  file_name: string
  direction: TransferDirection
  size: number
  transferred: number
  status: TransferStatus
  /** bytes/sec */
  speed: number
  started_at: number // Unix milliseconds
  finished_at?: number
  error_message?: string
}

/** A connected SFTP target server. */
export interface SftpServer {
  id: string
  name: string
  host: string
  port: number
  username: string
}

/** Response type for POST /api/sftp/sessions */
export interface SftpCreateSessionResponse {
  session_id: string
  status: string
}

/** Response type for GET /api/sftp/sessions/{id}/list */
export interface SftpListResponse {
  path: string
  entries: SftpEntry[]
}

/** Response type for GET /api/sftp/sessions/{id}/tree */
export interface SftpTreeResponse {
  path: string
  entries: SftpTreeNode[]
}

/** Response type for POST /api/sftp/sessions/{id}/upload */
export interface SftpUploadResponse {
  tasks: TransferTask[]
}

/** Response type for POST /api/sftp/sessions/{id}/download */
export interface SftpDownloadResponse {
  tasks: TransferTask[]
  download_url: string
}

/** Response type for POST /api/sftp/sessions/{id}/delete */
export interface SftpDeleteResponse {
  deleted: number
  failed: number
}

/** Conflict-resolution strategy for cross-session transfers. Mirrors the
 *  backend model.ConflictResolution enum. */
export type ConflictResolution = 'ask' | 'overwrite' | 'rename' | 'skip'

/** A single file collision detected before a transfer. Mirrors backend
 *  model.SftpConflictInfo. */
export interface SftpConflictInfo {
  source_path: string
  dest_path: string
  source_size: number
  dest_size: number
}

/** Response type for POST /api/sftp/transfer.
 *  On success: task_id/method/tasks are populated.
 *  On conflict (HTTP 409): conflicts is populated, task_id is empty. */
export interface SftpTransferResponse {
  task_id?: string
  method?: string
  tasks?: TransferTask[]
  conflicts?: SftpConflictInfo[]
}

/* ─── Built-in editor types ─── */

export type LineEnding = 'lf' | 'crlf'

/** Response type for GET /api/sftp/sessions/{id}/file?path=...
 *  Guards: backend rejects files >10MB (413), binary (415), non-UTF-8 (415). */
export interface SftpFileReadResponse {
  path: string
  content: string
  size: number
  /** RFC 3339Nano timestamp; used as the optimistic-lock token on save. */
  mod_time: string
  /** Monaco language id, e.g. "shell", "json", "nginx", "plaintext". */
  language: string
  line_ending: LineEnding
  /** True when the file's owner-write bit is unset. */
  read_only: boolean
}

/** Request body for PUT /api/sftp/sessions/{id}/file?path=... */
export interface SftpFileWriteRequest {
  content: string
  /** Must match the server's current ModTime; mismatch → 409 FILE_MODIFIED. */
  expected_mod_time: string
  line_ending?: LineEnding
}

/** Response type for PUT /api/sftp/sessions/{id}/file. The new mod_time
 *  becomes the optimistic-lock token for the next save. */
export interface SftpFileWriteResponse {
  path: string
  size: number
  mod_time: string
}
