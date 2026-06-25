import { api } from './client'
import type { SftpEntry, SftpListResponse } from '@/types/sftp'

// --- Types ---

export interface ServerSessionResponse {
  session_id: string
  status: string
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
  net_rx: number
  net_tx: number
  net_detail: NetIfStat[]
  timestamp: number
}

// Re-export unified types from sftp (backend returns SftpEntry format)
export type { SftpEntry, SftpListResponse }

// --- API ---

export const serverDetailApi = {
  createSession: (profileId: string) =>
    api.post<ServerSessionResponse>('/api/server/sessions', { profile_id: profileId }),

  closeSession: (sessionId: string) =>
    api.delete<void>(`/api/server/sessions/${sessionId}`),

  getInfo: (sessionId: string) =>
    api.get<ServerInfo>(`/api/server/sessions/${sessionId}/info`),

  listFiles: (sessionId: string, path: string) =>
    api.get<SftpListResponse>(
      `/api/server/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`
    ),
}
