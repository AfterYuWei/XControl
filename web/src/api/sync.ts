import { invokeCommand } from './tauri'
import type {
  SyncSettings, SyncStatus, SyncVersion, SyncEvent,
  SyncProviderMeta, ProviderConfig,
} from '@/types/sync'

export const syncApi = {
  status: () => invokeCommand<SyncStatus>('sync_status'),

  backupNow: () =>
    invokeCommand<{ created: boolean; message?: string; version?: SyncVersion }>('sync_backup_now'),

  versions: () => invokeCommand<SyncVersion[]>('sync_versions'),

  restoreVersion: (id: string) =>
    invokeCommand<{ restored: boolean }>('sync_restore_version', { id }),

  deleteVersion: (id: string, force = false) =>
    invokeCommand<void>('sync_delete_version', { id, force }),

  events: (limit = 50) => invokeCommand<SyncEvent[]>('sync_events', { limit }),

  settings: () => invokeCommand<SyncSettings>('sync_get_settings'),

  updateSettings: (settings: SyncSettings, syncPassword?: string) =>
    invokeCommand<{ saved: boolean }>('sync_update_settings', {
      settings,
      syncPassword: syncPassword || undefined,
    }),

  /** Decrypt and return the stored sync password (for display on demand). */
  revealPassword: () =>
    invokeCommand<{ sync_password: string }>('sync_reveal_password'),

  // ── Cloud sync (M2) ──
  syncNow: () => invokeCommand<{ started: boolean }>('sync_now'),
  push: () => invokeCommand<{ started: boolean }>('sync_push'),
  resolveConflict: (choice: 'keep_local' | 'use_cloud') =>
    invokeCommand<{ resolved: boolean }>('sync_resolve_conflict', { choice }),

  providers: () => invokeCommand<SyncProviderMeta[]>('sync_providers'),
  createProvider: (cfg: ProviderConfig) =>
    invokeCommand<SyncProviderMeta>('sync_create_provider', { config: cfg }),
  updateProvider: (id: string, cfg: ProviderConfig) =>
    invokeCommand<{ saved: boolean }>('sync_update_provider', { id, config: cfg }),
  deleteProvider: (id: string) => invokeCommand<void>('sync_delete_provider', { id }),
  testProvider: (id: string) =>
    invokeCommand<{ saved: boolean }>('sync_test_provider', { id }),

  // OAuth (M3)
  oauthURL: (type: 'gdrive' | 'onedrive', providerId: string) =>
    invokeCommand<{ url: string }>('sync_oauth_url', {
      providerType: type,
      providerId,
    }),
}
