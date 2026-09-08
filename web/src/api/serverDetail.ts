import { invokeCommand } from './tauri'
import { sftpApi } from './sftp'
import type { SftpEntry, SftpListResponse } from '@/types/sftp'

// --- Types ---

export interface ServerSessionResponse {
  session_id: string
  status: string
  home_dir?: string // User's home directory
}

export interface ServerInfo {
  hostname: string
  os: string
  kernel: string
  arch: string
  uptime: string
  load_avg: string
  load_avg_detail: string
  cpus: number
  cpu_mhz: number // CPU frequency in MHz
}

export interface NetIfStat {
  name: string
  rx: number
  tx: number
}

export interface ProcMem {
  name: string
  percent: number
  rss: number
}

export interface ServerMetrics {
  cpu: number
  cpu_detail: number[]
  mem_used: number
  mem_total: number
  mem_percent: number
  mem_detail: ProcMem[]
  disk_used: number
  disk_total: number
  disk_percent: number
  cpu_mhz: number // CPU frequency in MHz (dynamic, real-time)
  net_rx: number
  net_tx: number
  net_detail: NetIfStat[]
  timestamp: number
}

// Re-export unified types from sftp (backend returns SftpEntry format)
export type { SftpEntry, SftpListResponse }

// --- API ---

export const serverDetailApi = {
  createSession: async (profileId: string): Promise<ServerSessionResponse> => {
    const response = await sftpApi.createSession(profileId)
    let status = response.status
    let homeDir = response.home_dir
    const deadline = Date.now() + 30_000
    while (status === 'connecting' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const session = await sftpApi.getSession(response.session_id)
      if (session.error) throw new Error(session.error)
      status = session.status
      homeDir = session.home_dir ?? homeDir
    }
    if (status !== 'connected') throw new Error(`连接失败: ${status}`)
    return { session_id: response.session_id, status, home_dir: homeDir }
  },

  closeSession: (sessionId: string) =>
    sftpApi.closeSession(sessionId),

  getInfo: (sessionId: string) =>
    invokeCommand<ServerInfo>('server_get_info', { sessionId }),

  listFiles: (sessionId: string, path: string, showHidden = false) =>
    sftpApi.list(sessionId, path, showHidden),

  mkdir: (sessionId: string, path: string) =>
    sftpApi.mkdir(sessionId, path),

  rename: (sessionId: string, oldPath: string, newPath: string) =>
    sftpApi.rename(sessionId, oldPath, newPath),

  delete: (sessionId: string, paths: string[]) =>
    sftpApi.delete(sessionId, paths),

  getMetrics: (sessionId: string) =>
    invokeCommand<ServerMetrics>('server_get_metrics', { sessionId }),
}
