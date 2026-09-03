import { authedFetch, type APIError } from './client'
import { isTauri, saveApiFileToDisk } from '@/lib/desktop'

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
}

async function parseError(res: Response): Promise<never> {
  const err: APIError = await res.json().catch(() => ({
    error: { code: 'UNKNOWN', message: res.statusText },
  }))
  throw err
}

/** Trigger a download of the backup file.
 *  桌面端（Tauri）：Rust 侧流式拉取 + 系统保存对话框（blob 锚点在
 *  WKWebView/WebKitGTK 下不可靠）；浏览器：blob + <a download>。 */
export async function exportBackup(
  mode: CredentialMode,
  password?: string
): Promise<void> {
  const params = new URLSearchParams({ credentials: mode })
  if (password) params.set('password', password)

  if (isTauri()) {
    const stamp = new Date().toISOString().slice(0, 10)
    await saveApiFileToDisk(
      `/api/backup/export?${params}`,
      `xcontrol-backup-${stamp}.xcbackup`,
    )
    return // 用户取消时静默返回（后端错误以 rejected promise 抛出）
  }

  const res = await authedFetch(`/api/backup/export?${params}`)
  if (!res.ok) return parseError(res)

  const blob = await res.blob()
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const match = disposition.match(/filename="?([^";]+)"?/)
  const filename = match?.[1] ?? `xcontrol-backup-${Date.now()}.xcbackup`

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

async function upload<T>(
  path: string,
  file: File,
  fields: Record<string, string>
): Promise<T> {
  const form = new FormData()
  form.append('file', file)
  for (const [k, v] of Object.entries(fields)) {
    if (v) form.append(k, v)
  }
  const res = await authedFetch(path, { method: 'POST', body: form })
  if (!res.ok) return parseError(res)
  return res.json()
}

export function previewBackup(file: File, password?: string) {
  return upload<BackupPreview>('/api/backup/preview', file, {
    password: password ?? '',
  })
}

export function importBackup(
  file: File,
  strategy: ImportStrategy,
  password?: string
) {
  return upload<BackupImportResult>('/api/backup/import', file, {
    strategy,
    password: password ?? '',
  })
}
