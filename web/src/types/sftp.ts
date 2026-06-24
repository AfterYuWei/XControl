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
