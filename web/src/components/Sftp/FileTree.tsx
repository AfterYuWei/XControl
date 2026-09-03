import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Folder, FileText, FileCode, FileArchive, FileImage } from 'lucide-react'
import { ancestorsOf, type TreeNode, type SftpDropTarget } from '@/store/sftp'
import { dropPayloadAttr } from '@/lib/dragRegistry'
import type { SftpEntry } from '@/types/sftp'

interface FileTreeProps {
  root: TreeNode
  activePath: string
  selected: Set<string>
  onSelect: (entry: SftpEntry, additive: boolean) => void
  onActivate: (entry: SftpEntry) => void
  onContextMenu: (e: React.MouseEvent, entry: SftpEntry) => void
  /** 指针拖拽启动（P3：替代 HTML5 draggable/onDragStart）。 */
  onRowPointerDown: (e: React.PointerEvent, entry: SftpEntry) => void
  dropTargetPath?: string | null
  draggingPaths?: Set<string>
  /** 目录行作为拖放目标的构造器（仅文件夹行渲染 data-drag-payload）。 */
  makeDropTarget: (entry: SftpEntry) => SftpDropTarget | null
}

function renderFileIcon(name: string, size: number) {
  const lower = name.toLowerCase()
  if (/\.(zip|tar|gz|rar|7z)$/.test(lower)) return <FileArchive size={size} />
  if (/\.(png|jpe?g|gif|svg|webp)$/.test(lower)) return <FileImage size={size} />
  if (/\.(ts|tsx|js|jsx|json|go|py|yml|yaml|sh|md|html|css)$/.test(lower)) return <FileCode size={size} />
  return <FileText size={size} />
}

/** Expandable directory tree. Folders collapse via a chevron; the active
 *  path's ancestors are always expanded (derived, not via effect) so the
 *  current location stays visible. User toggles add extra expansions. */
export function FileTree({
  root,
  activePath,
  selected,
  onSelect,
  onActivate,
  onContextMenu,
  onRowPointerDown,
  dropTargetPath,
  draggingPaths,
  makeDropTarget,
}: FileTreeProps) {
  // Extra folders the user has explicitly expanded beyond the active path's
  // ancestors. Collapsing an ancestor of the active path is ignored (kept
  // open) so the current location never disappears.
  const [userExpanded, setUserExpanded] = useState<Set<string>>(() => new Set())

  const expanded = useMemo(
    () => new Set<string>([...ancestorsOf(activePath), ...userExpanded]),
    [activePath, userExpanded]
  )

  const toggle = (path: string) =>
    setUserExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  // 悬停弹簧展开（P3）：拖拽期间 dropTarget 停留在未展开的目录行上 700ms
  // 即自动展开（由 store 的 dropTarget 驱动，替代原 HTML5 onDragOver 定时器）
  const springRef = useRef<string | null>(null)
  useEffect(() => {
    if (!dropTargetPath) {
      springRef.current = null
      return
    }
    if (springRef.current === dropTargetPath) return
    springRef.current = dropTargetPath
    const timer = setTimeout(() => {
      setUserExpanded((prev) => new Set(prev).add(dropTargetPath))
    }, 700)
    return () => clearTimeout(timer)
  }, [dropTargetPath])

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const e = node.entry
    const isExpanded = expanded.has(e.path)
    const isActive = e.path === activePath
    const isSelected = selected.has(e.path)
    const indent = 8 + depth * 14
    const rowDropTarget = e.is_dir ? makeDropTarget(e) : null

    const cls = [
      'sftp-trow',
      isSelected ? 'sel' : '',
      isActive ? 'active-path' : '',
      dropTargetPath === e.path ? 'drop-target' : '',
      draggingPaths?.has(e.path) ? 'dragging' : '',
      e.is_dir ? 'is-dir' : 'is-file',
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <div key={e.path}>
        <div
          className={cls}
          role="row"
          tabIndex={0}
          style={{ paddingLeft: indent }}
          onPointerDown={(ev) => onRowPointerDown(ev, e)}
          onClick={(ev) => {
            ev.stopPropagation()
            onSelect(e, ev.metaKey || ev.ctrlKey)
          }}
          onDoubleClick={() => {
            if (e.is_dir) toggle(e.path)
            else onActivate(e)
          }}
          onContextMenu={(ev) => onContextMenu(ev, e)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') {
              if (e.is_dir) toggle(e.path)
              else onActivate(e)
            }
          }}
          data-drag-payload={rowDropTarget ? dropPayloadAttr({ kind: 'sftp', target: rowDropTarget }) : undefined}
        >
          <span className="sftp-trow-chevron">
            {e.is_dir ? (
              <ChevronRight
                size={13}
                className={isExpanded ? 'sftp-chev-open' : ''}
                onClick={(ev) => {
                  ev.stopPropagation()
                  toggle(e.path)
                }}
              />
            ) : null}
          </span>
          <span className="sftp-trow-icon">
            {e.is_dir ? <Folder size={14} /> : renderFileIcon(e.name, 14)}
          </span>
          <span className="sftp-trow-name" title={e.name}>
            {e.name}
          </span>
        </div>
        {e.is_dir && isExpanded && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  return <div className="sftp-tree">{root.children.map((child) => renderNode(child, 0))}</div>
}
