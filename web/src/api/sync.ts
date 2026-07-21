import { api } from './client'
import type {
  SyncSettings, SyncStatus, SyncVersion, SyncEvent,
  SyncProviderMeta, ProviderConfig,
} from '@/types/sync'

export const syncApi = {
  status: () => api.get<SyncStatus>('/api/sync/status'),

  backupNow: () =>
    api.post<{ created: boolean; message?: string; version?: SyncVersion }>(
      '/api/sync/backup'
    ),

  versions: () => api.get<SyncVersion[]>('/api/sync/versions'),

  restoreVersion: (id: string) =>
    api.post<{ restored: boolean }>(`/api/sync/versions/${id}/restore`),

  deleteVersion: (id: string, force = false) =>
    api.delete(`/api/sync/versions/${id}${force ? '?force=1' : ''}`),

  events: (limit = 50) => api.get<SyncEvent[]>(`/api/sync/events?limit=${limit}`),

  settings: () => api.get<SyncSettings>('/api/sync/settings'),

  updateSettings: (settings: SyncSettings, syncPassword?: string) =>
    api.put<{ saved: boolean }>('/api/sync/settings', {
      ...settings,
      sync_password: syncPassword || undefined,
    }),

  /** Fire-and-forget exit backup via sendBeacon (survives page unload). */
  notifyShutdown: () => {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon('/api/sync/shutdown')
    }
  },

  // ── Cloud sync (M2) ──
  syncNow: () => api.post<{ started: boolean }>('/api/sync/now'),
  push: () => api.post<{ started: boolean }>('/api/sync/push'),
  resolveConflict: (choice: 'keep_local' | 'use_cloud') =>
    api.post<{ resolved: boolean }>('/api/sync/resolve', { choice }),

  providers: () => api.get<SyncProviderMeta[]>('/api/sync/providers'),
  createProvider: (cfg: ProviderConfig) =>
    api.post<SyncProviderMeta>('/api/sync/providers', cfg),
  updateProvider: (id: string, cfg: ProviderConfig) =>
    api.put<{ saved: boolean }>(`/api/sync/providers/${id}`, cfg),
  deleteProvider: (id: string) => api.delete(`/api/sync/providers/${id}`),
  testProvider: (id: string) =>
    api.post<{ ok: boolean }>(`/api/sync/providers/${id}/test`),

  // OAuth (M3)
  oauthURL: (type: 'gdrive' | 'onedrive', providerId: string) =>
    api.get<{ url: string }>(`/api/sync/oauth/${type}/url?provider_id=${providerId}`),
}
