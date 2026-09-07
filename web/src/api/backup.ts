import { authedFetch, type APIError } from './client'
import { isTauri, saveApiFileToDisk } from '@/lib/desktop'
import { invoke } from '@tauri-apps/api/core'

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

/** 待导入的备份文件。
 * - 浏览器模式：`file` 为 `<input type="file">` 的 File 对象
 * - 桌面模式（Tauri）：`path` 为 Rust 系统对话框返回的磁盘路径 */
export interface BackupSource {
  /** 显示用文件名 */
  name: string
  file?: File
  path?: string
}

/** Rust upload_file_form 的返回：状态码 + 响应体 JSON 文本。 */
interface UploadOutcome {
  status: number
  body: string
}

async function parseError(res: Response): Promise<never> {
  const err: APIError = await res.json().catch(() => ({
    error: { code: 'UNKNOWN', message: res.statusText },
  }))
  throw err
}

/** 解析 Rust 侧上传的非 2xx 响应体并抛出与 parseError 同构的错误。 */
function throwOutcomeError(outcome: UploadOutcome): never {
  let parsed: APIError | null
  try {
    parsed = JSON.parse(outcome.body) as APIError
  } catch {
    parsed = null
  }
  if (parsed?.error?.code) throw parsed
  throw {
    error: { code: 'UNKNOWN', message: outcome.body || `HTTP ${outcome.status}` },
  } satisfies APIError
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
  src: BackupSource,
  fields: Record<string, string>
): Promise<T> {
  // 桌面端：WebView2/WebKit 虚拟源下 File/blob 经 fetch FormData 发送会以
  // "Failed to fetch" 失败，改走 Rust 侧上传（读盘直传本机 sidecar，不进 IPC）。
  if (src.path) {
    const extra = Object.fromEntries(Object.entries(fields).filter(([, v]) => v))
    const outcome = await invoke<UploadOutcome>('upload_file_form', {
      endpoint: path,
      filePath: src.path,
      fields: extra,
    })
    if (outcome.status < 200 || outcome.status >= 300) throwOutcomeError(outcome)
    return JSON.parse(outcome.body) as T
  }

  // 浏览器：先读入内存再以内存 Blob 上传（避免 file-backed blob 兼容性问题）
  const file = src.file
  if (!file) throw new Error('未提供备份文件')
  const bytes = await file.arrayBuffer()
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: file.type || 'application/json' }), src.name)
  for (const [k, v] of Object.entries(fields)) {
    if (v) form.append(k, v)
  }
  const res = await authedFetch(path, { method: 'POST', body: form })
  if (!res.ok) return parseError(res)
  return res.json()
}

export function previewBackup(src: BackupSource, password?: string) {
  return upload<BackupPreview>('/api/backup/preview', src, {
    password: password ?? '',
  })
}

export function importBackup(
  src: BackupSource,
  strategy: ImportStrategy,
  password?: string
) {
  return upload<BackupImportResult>('/api/backup/import', src, {
    strategy,
    password: password ?? '',
  })
}
