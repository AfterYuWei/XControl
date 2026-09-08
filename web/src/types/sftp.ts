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

export type TransferDirection = 'upload' | 'download' | 'transfer'
export type DirectoryTransferMode = 'preserve' | 'archive'
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
  /** 所属分组 id（未分组为空） */
  groupId?: string
  /** 图标 key，由前端 resolveServerIcon 解析为 Lucide 组件 */
  icon?: string
}

/** Response from the SFTP session creation command. */
export interface SftpCreateSessionResponse {
  session_id: string
  status: string
  home_dir?: string // User's home directory
}

/** Response from the SFTP list command. */
export interface SftpListResponse {
  path: string
  entries: SftpEntry[]
}

/** Response from the SFTP tree command. */
export interface SftpTreeResponse {
  path: string
  entries: SftpTreeNode[]
}

/** Response from the SFTP upload command. */
export interface SftpUploadResponse {
  tasks: TransferTask[]
}

export interface SftpUploadBeginResponse extends SftpUploadResponse {
  upload_id: string
}

/** Response from the SFTP download command. */
export interface SftpDownloadResponse {
  tasks: TransferTask[]
  download_url: string
}

/** Response from the SFTP delete command. */
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
  source_is_dir?: boolean
  dest_is_dir?: boolean
}

export interface SftpMoveFailure {
  path: string
  message: string
}

export interface SftpMoveResponse {
  moved: string[]
  skipped: string[]
  failures: SftpMoveFailure[]
  conflicts?: SftpConflictInfo[]
}

/** Cross-session transfer response. On a conflict, task_id is empty. */
export interface SftpTransferResponse {
  task_id?: string
  method?: string
  tasks?: TransferTask[]
  conflicts?: SftpConflictInfo[]
}

/* ─── Built-in editor types ─── */

export type LineEnding = 'lf' | 'crlf'

/** Editor read response; Rust rejects files over 10 MiB, binary and non-UTF-8 content. */
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

/** Editor write request. */
export interface SftpFileWriteRequest {
  content: string
  /** Must match the server's current ModTime; mismatch → 409 FILE_MODIFIED. */
  expected_mod_time: string
  line_ending?: LineEnding
}

/** Editor write response. The new mod_time
 *  becomes the optimistic-lock token for the next save. */
export interface SftpFileWriteResponse {
  path: string
  size: number
  mod_time: string
}
