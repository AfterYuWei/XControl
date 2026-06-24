/** SFTP file entry — mirrors a future backend SFTP stat response. */
export interface SftpEntry {
  name: string
  /** Absolute or relative path (without trailing slash). */
  path: string
  isDir: boolean
  size: number // bytes; 0 for directories
  modTime: string // ISO timestamp
  /** Unix permission hint, e.g. "rwxr-xr-x". Optional. */
  mode?: string
}

export type TransferDirection = 'upload' | 'download'
export type TransferStatus = 'queued' | 'transferring' | 'completed' | 'failed' | 'cancelled'

export interface TransferTask {
  id: string
  fileName: string
  direction: TransferDirection
  size: number
  transferred: number
  status: TransferStatus
  /** bytes/sec, simulated for mock. */
  speed: number
  startedAt: number
  finishedAt?: number
  errorMessage?: string
}

/** A connected SFTP target server (mock). */
export interface SftpServer {
  id: string
  name: string
  host: string
  port: number
  username: string
}
