import { AlertTriangle, FileWarning, X } from 'lucide-react'
import { Dialog } from '@/components/ui/dialog'
import { useSftpStore } from './storeContext'
import type { ConflictResolution } from '@/types/sftp'

/** Conflict-resolution dialog. Shown when a cross-pane transfer would
 *  overwrite existing destination files. The user picks one of three
 *  strategies which is then applied to ALL conflicting files in the batch:
 *    - overwrite: replace existing destination files
 *    - rename:    auto-rename incoming files (e.g. "file (1).txt")
 *    - skip:      skip conflicting files, transfer the rest
 *  Non-conflicting files in the same batch are always transferred. */
export function ConflictDialog() {
  const pending = useSftpStore((s) => s.pendingConflict)
  const resolve = useSftpStore((s) => s.resolveConflict)
  const dismiss = useSftpStore((s) => s.dismissConflict)

  const open = pending !== null
  const conflicts = pending?.conflicts ?? []

  const choose = (resolution: ConflictResolution) => {
    resolve(resolution)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && dismiss()}>
      <div className="sftp-conflict">
        <div className="sftp-conflict-hdr">
          <AlertTriangle size={16} className="sftp-conflict-warn" />
          <span className="sftp-conflict-title">文件冲突</span>
          <button className="sftp-picker-x" onClick={dismiss} aria-label="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="sftp-conflict-sub">
          目标位置已存在 {conflicts.length} 个同名文件。请选择处理方式（将应用到全部冲突文件，未冲突文件正常传输）。
        </div>

        <div className="sftp-conflict-list">
          {conflicts.map((c) => (
            <div key={c.dest_path} className="sftp-conflict-row">
              <FileWarning size={14} className="sftp-conflict-row-icon" />
              <div className="sftp-conflict-row-info">
                <div className="sftp-conflict-row-name" title={c.dest_path}>
                  {baseName(c.dest_path)}
                </div>
                <div className="sftp-conflict-row-meta">
                  <span>源 {formatSize(c.source_size)}</span>
                  <span className="sftp-conflict-row-sep">→</span>
                  <span>目标 {formatSize(c.dest_size)}</span>
                </div>
                <div className="sftp-conflict-row-path" title={c.dest_path}>
                  {c.dest_path}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="sftp-conflict-actions">
          <button
            className="sftp-conflict-btn primary"
            onClick={() => choose('overwrite')}
          >
            覆盖
          </button>
          <button
            className="sftp-conflict-btn"
            onClick={() => choose('rename')}
          >
            重命名
          </button>
          <button
            className="sftp-conflict-btn"
            onClick={() => choose('skip')}
          >
            跳过冲突文件
          </button>
          <button className="sftp-conflict-btn ghost" onClick={dismiss}>
            取消
          </button>
        </div>
      </div>
    </Dialog>
  )
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
