import { invokeCommand } from './tauri'
import type { Group } from '@/types/group'
import type { Profile } from '@/types/profile'
import type { VaultItem } from '@/types/vault'

export type CredentialMode = 'none' | 'encrypted' | 'plain'
export type ImportStrategy = 'skip' | 'overwrite' | 'regenerate'

export interface BackupStats {
  groups: number
  vault: number
  profiles: number
  snippets: number
}

export interface BackupPreview {
  credential_mode: CredentialMode
  exported_at: string
  stats: BackupStats
  conflicts: BackupStats
}

export interface BackupImportResult {
  imported: BackupStats
  skipped: BackupStats
  snapshot?: {
    groups: Group[]
    profiles: Profile[]
    vault: VaultItem[]
  }
  snapshot_error?: string
}

/** Rust 系统对话框返回的待导入文件；正文始终留在 Rust 侧。 */
export interface BackupSource {
  name: string
  path: string
}

export async function pickBackupFile(): Promise<BackupSource | null> {
  const path = await invokeCommand<string | null>('backup_pick_file')
  if (!path) return null
  return { name: path.split(/[\\/]/).pop() ?? path, path }
}

/** Rust 直接导出数据库并通过系统保存对话框落盘。 */
export async function exportBackup(
  mode: CredentialMode,
  password?: string,
): Promise<void> {
  await invokeCommand<string | null>('backup_export', { mode, password })
}

export function previewBackup(src: BackupSource, password?: string) {
  return invokeCommand<BackupPreview>('backup_preview', {
    filePath: src.path,
    password,
  })
}

export function importBackup(
  src: BackupSource,
  strategy: ImportStrategy,
  password?: string,
) {
  return invokeCommand<BackupImportResult>('backup_import', {
    filePath: src.path,
    strategy,
    password,
  })
}
