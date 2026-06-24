import { useState } from 'react'
import {
  ArrowUp,
  ArrowDown,
  X,
  Check,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Trash2,
} from 'lucide-react'
import { useSftpStore } from './storeContext'
import type { TransferTask } from '@/types/sftp'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
}

function statusMeta(task: TransferTask) {
  switch (task.status) {
    case 'transferring':
      return { icon: <Loader2 size={12} className="sftp-tx-spin" />, label: '传输中', cls: 'transferring' }
    case 'completed':
      return { icon: <Check size={12} />, label: '已完成', cls: 'completed' }
    case 'failed':
      return { icon: <AlertCircle size={12} />, label: '失败', cls: 'failed' }
    case 'cancelled':
      return { icon: <X size={12} />, label: '已取消', cls: 'cancelled' }
    default:
      return { icon: <Loader2 size={12} />, label: '排队中', cls: 'queued' }
  }
}

export function TransferQueue() {
  const { transfers, cancelTransfer, clearCompleted } = useSftpStore()
  const [collapsed, setCollapsed] = useState(false)

  const active = transfers.filter((t) => t.status === 'transferring' || t.status === 'queued')
  const done = transfers.filter((t) => t.status !== 'transferring' && t.status !== 'queued')

  if (transfers.length === 0) return null

  const totalProgress =
    transfers.length > 0
      ? transfers.reduce((sum, t) => sum + (t.size ? t.transferred / t.size : 0), 0) / transfers.length
      : 0

  return (
    <div className={`sftp-tx ${collapsed ? 'collapsed' : ''}`}>
      <div className="sftp-tx-hdr" onClick={() => setCollapsed((v) => !v)}>
        <div className="sftp-tx-hdr-left">
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          <span className="sftp-tx-title">传输队列</span>
          <span className="sftp-tx-count">
            {active.length > 0 ? `${active.length} 个进行中` : `${done.length} 个已完成`}
          </span>
          {active.length > 0 && (
            <div className="sftp-tx-mini-bar">
              <div className="sftp-tx-mini-fill" style={{ width: `${totalProgress * 100}%` }} />
            </div>
          )}
        </div>
        <div className="sftp-tx-hdr-right">
          {done.length > 0 && (
            <button
              className="sftp-tx-clear"
              title="清除已完成"
              onClick={(e) => {
                e.stopPropagation()
                clearCompleted()
              }}
            >
              <Trash2 size={12} />
              清除
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="sftp-tx-list">
          {transfers.map((task) => {
            const meta = statusMeta(task)
            const pct = task.size ? Math.min(100, Math.round((task.transferred / task.size) * 100)) : 0
            return (
              <div key={task.id} className={`sftp-tx-item ${meta.cls}`}>
                <span className="sftp-tx-dir">
                  {task.direction === 'upload' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                </span>
                <span className="sftp-tx-name" title={task.file_name}>
                  {task.file_name}
                </span>
                <span className="sftp-tx-progress">
                  <div className="sftp-tx-bar">
                    <div className={`sftp-tx-fill ${meta.cls}`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="sftp-tx-pct">{pct}%</span>
                </span>
                <span className="sftp-tx-size">
                  {formatSize(task.transferred)} / {formatSize(task.size)}
                </span>
                <span className={`sftp-tx-status ${meta.cls}`}>
                  {meta.icon}
                  {task.status === 'transferring' ? formatSpeed(task.speed) : meta.label}
                </span>
                {(task.status === 'transferring' || task.status === 'queued') && (
                  <button
                    className="sftp-tx-cancel"
                    title="取消"
                    onClick={(e) => {
                      e.stopPropagation()
                      cancelTransfer(task.id)
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
