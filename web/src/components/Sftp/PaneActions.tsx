import {
  FolderPlus,
  RefreshCw,
  Pencil,
  Trash2,
  Copy,
  List,
  FolderTree,
} from 'lucide-react'
import type { SftpViewMode } from '@/store/sftp'

interface PaneActionsProps {
  view: SftpViewMode
  hasSelection: boolean
  onToggleView: () => void
  onRefresh: () => void
}

/** Action buttons rendered on the right of the breadcrumb row. The view
 *  toggle is per-tab: it only flips the active tab's view mode, so the two
 *  panes (and different tabs in the same pane) can independently be list
 *  vs tree. */
export function PaneActions({ view, hasSelection, onToggleView, onRefresh }: PaneActionsProps) {
  return (
    <div className="sftp-actions">
      <ActionBtn icon={<FolderPlus size={13} />} label="新建文件夹" onClick={() => {}} />
      <ActionBtn icon={<RefreshCw size={13} />} label="刷新" onClick={onRefresh} />
      <span className="sftp-actions-sep" />
      <ActionBtn icon={<Pencil size={13} />} label="重命名" disabled={!hasSelection} onClick={() => {}} />
      <ActionBtn icon={<Trash2 size={13} />} label="删除" disabled={!hasSelection} onClick={() => {}} />
      <ActionBtn icon={<Copy size={13} />} label="复制路径" disabled={!hasSelection} onClick={() => {}} />
      <span className="sftp-actions-sep" />
      <ActionBtn
        icon={view === 'list' ? <FolderTree size={13} /> : <List size={13} />}
        label={view === 'list' ? '切换到树形视图' : '切换到列表视图'}
        onClick={onToggleView}
        on
      />
    </div>
  )
}

function ActionBtn({
  icon,
  label,
  onClick,
  disabled,
  on,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  on?: boolean
}) {
  return (
    <button
      className={`sftp-act-btn ${on ? 'on' : ''}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
    </button>
  )
}
