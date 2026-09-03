import { Folder, FileText, FileCode, FileArchive, FileImage } from 'lucide-react'
import type { SftpEntry } from '@/types/sftp'
import { dropPayloadAttr } from '@/lib/dragRegistry'
import type { SftpDropTarget } from '@/store/sftp'

interface FileRowProps {
  entry: SftpEntry
  selected: boolean
  dragging: boolean
  isDropTarget: boolean
  onSelect: (e: React.MouseEvent) => void
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
  /** 指针拖拽启动（P3：替代 HTML5 draggable/onDragStart）。 */
  onRowPointerDown: (e: React.PointerEvent) => void
  /** 仅文件夹行：作为拖放目标（渲染 data-drag-payload 供 hitTest 命中）。 */
  dropTarget?: SftpDropTarget | null
}

/** Render the appropriate line icon for a file name as JSX (avoids creating
 *  a component reference during render, which the linter flags). */
function renderFileIcon(name: string, size: number) {
  const lower = name.toLowerCase()
  if (/\.(zip|tar|gz|rar|7z)$/.test(lower)) return <FileArchive size={size} />
  if (/\.(png|jpe?g|gif|svg|webp)$/.test(lower)) return <FileImage size={size} />
  if (/\.(ts|tsx|js|jsx|json|go|py|yml|yaml|sh|md|html|css)$/.test(lower)) return <FileCode size={size} />
  return <FileText size={size} />
}

function formatSize(bytes: number, isDir: boolean): string {
  if (isDir) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function FileRow({
  entry,
  selected,
  dragging,
  isDropTarget,
  onSelect,
  onOpen,
  onContextMenu,
  onRowPointerDown,
  dropTarget,
}: FileRowProps) {
  const cls = [
    'sftp-row',
    selected ? 'sel' : '',
    dragging ? 'dragging' : '',
    isDropTarget ? 'drop-target' : '',
    entry.is_dir ? 'is-dir' : 'is-file',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cls}
      role="row"
      tabIndex={0}
      onPointerDown={onRowPointerDown}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
      data-drag-payload={dropTarget ? dropPayloadAttr({ kind: 'sftp', target: dropTarget }) : undefined}
    >
      <span className="sftp-cell sftp-cell-icon">
        {entry.is_dir ? <Folder size={14} /> : renderFileIcon(entry.name, 14)}
      </span>
      <span className="sftp-cell sftp-cell-name" title={entry.name}>
        {entry.name}
      </span>
      <span className="sftp-cell sftp-cell-size">{formatSize(entry.size, entry.is_dir)}</span>
      <span className="sftp-cell sftp-cell-date">{formatDate(entry.mod_time)}</span>
    </div>
  )
}
