export type SyncMode = 'manual' | 'auto'
export type ConflictPolicy = 'prompt' | 'latest'
export type CloudRetention = 'keep_forever' | 'mirror_local'

export interface SyncVersion {
  id: string
  version: number
  hash: string
  size: number
  origin: string
  synced_to: string[]
  created_at: string
}

export interface SyncVersionInfo {
  version: number
  hash: string
  size: number
  created_at: string
}

export interface SyncProviderMeta {
  id: string
  type: 'webdav' | 's3' | 'gdrive' | 'onedrive'
  name: string
  enabled: boolean
  authorized?: boolean
  created_at: string
  updated_at: string
}

export interface SyncConflictInfo {
  provider_id: string
  provider_name: string
  local: SyncVersionInfo
  cloud: SyncVersionInfo
}

export interface SyncStatus {
  status: 'idle' | 'syncing' | 'conflict' | 'error'
  local_latest: SyncVersionInfo | null
  cloud_latest: Record<string, SyncVersionInfo>
  providers: SyncProviderMeta[]
  conflict: SyncConflictInfo | null
  last_sync_at: string | null
}

export interface SyncSettings {
  sync_mode: SyncMode
  conflict_policy: ConflictPolicy
  cloud_retention: CloudRetention
  local_keep_versions: number
  scheduled_enabled: boolean
  scheduled_interval_hours: number
  scheduled_daily_time: string
  auto_backup_enabled: boolean
  change_debounce_seconds: number
  sync_password_set: boolean
}

export interface SyncEvent {
  id: string
  provider_id: string
  action: string
  version: number
  success: boolean
  error?: string
  created_at: string
}

export type ProviderType = 'webdav' | 's3' | 'gdrive' | 'onedrive'

export interface ProviderConfig {
  type: ProviderType
  name: string
  enabled: boolean
  // WebDAV
  endpoint?: string
  username?: string
  password?: string
  // S3
  s3_endpoint?: string
  s3_region?: string
  s3_bucket?: string
  s3_access_key?: string
  s3_secret_key?: string
  s3_prefix?: string
  s3_path_style?: boolean
  // OAuth (gdrive / onedrive)
  oauth_client_id?: string
  oauth_client_secret?: string
  onedrive_folder?: string
}

export const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
  webdav: 'WebDAV',
  s3: 'S3 兼容存储',
  gdrive: 'Google Drive',
  onedrive: 'OneDrive',
}

export const ACTION_LABELS: Record<string, string> = {
  backup: '创建版本',
  push: '推送',
  pull: '拉取',
  delete: '删除',
  restore: '恢复',
  resolve: '冲突解决',
  sync: '同步',
}

export const ORIGIN_LABELS: Record<string, string> = {
  manual: '手动备份',
  scheduled: '定时备份',
  shutdown: '退出时自动',
  change: '变更自动',
  conflict_resolve: '冲突解决',
  restore: '恢复操作',
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
