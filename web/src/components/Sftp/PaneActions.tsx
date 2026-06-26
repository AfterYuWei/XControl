import {
  FilePlus,
  FolderPlus,
  RefreshCw,
  Pencil,
  Trash2,
  Copy,
  List,
  FolderTree,
  Eye,
  EyeOff,
} from 'lucide-react'
import type { SftpViewMode } from '@/store/sftp'

interface PaneActionsProps {
  view: SftpViewMode
  showHidden: boolean
  hasSelection: boolean
  selectedCount: number
  onToggleView: () => void
  onToggleShowHidden: () => void
  onRefresh: () => void
  onNewFile: () => void
  onNewFolder: () => void
  onRename: () => void
  onDelete: () => void
  onCopyPath: () => void
}

/** Action buttons rendered on the right of the breadcrumb row. The view
 *  toggle is per-tab: it only flips the active tab's view mode, so the two
 *  panes (and different tabs in the same pane) can independently be list
 *  vs tree. */
export function PaneActions({
  view,
  showHidden,
  hasSelection,
  selectedCount,
  onToggleView,
  onToggleShowHidden,
  onRefresh,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  onCopyPath,
}: PaneActionsProps) {
  return (
    <div className="sftp-actions">
      <ActionBtn icon={<FilePlus size={13} />} label="新建文件" onClick={onNewFile} />
      <ActionBtn icon={<FolderPlus size={13} />} label="新建文件夹" onClick={onNewFolder} />
      <ActionBtn icon={<RefreshCw size={13} />} label="刷新" onClick={onRefresh} />
      <span className="sftp-actions-sep" />
      <ActionBtn
        icon={showHidden ? <EyeOff size={13} /> : <Eye size={13} />}
        label={showHidden ? '隐藏隐藏文件' : '显示隐藏文件'}
        onClick={onToggleShowHidden}
      />
      <ActionBtn
        icon={<Pencil size={13} />}
        label="重命名"
        disabled={!hasSelection || selectedCount > 1}
        onClick={onRename}
      />
      <ActionBtn icon={<Trash2 size={13} />} label="删除" disabled={!hasSelection} onClick={onDelete} />
      <ActionBtn icon={<Copy size={13} />} label="复制路径" disabled={!hasSelection} onClick={onCopyPath} />
      <span className="sftp-actions-sep" />
      <ActionBtn
        icon={view === 'list' ? <FolderTree size={13} /> : <List size={13} />}
        label={view === 'list' ? '切换到树形视图' : '切换到列表视图'}
        onClick={onToggleView}
      />
    </div>
  )
}

function ActionBtn({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      className="sftp-act-btn"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
    </button>
  )
}
