import { useMemo, useState } from 'react'
import { ChevronRight, Folder, FileText, FileCode, FileArchive, FileImage } from 'lucide-react'
import { ancestorsOf, type TreeNode, type PaneSide } from '@/store/sftp'
import type { SftpEntry } from '@/types/sftp'

interface FileTreeProps {
  root: TreeNode
  activePath: string
  selected: Set<string>
  onSelect: (entry: SftpEntry, additive: boolean) => void
  onActivate: (entry: SftpEntry) => void
  onContextMenu: (e: React.MouseEvent, entry: SftpEntry) => void
  onDragStart: (e: React.DragEvent, entry: SftpEntry) => void
  pane: PaneSide
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
  onDragStart,
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

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const e = node.entry
    const isExpanded = expanded.has(e.path)
    const isActive = e.path === activePath
    const isSelected = selected.has(e.path)
    const indent = 8 + depth * 14

    const cls = [
      'sftp-trow',
      isSelected ? 'sel' : '',
      isActive ? 'active-path' : '',
      e.isDir ? 'is-dir' : 'is-file',
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
          draggable
          onClick={(ev) => {
            ev.stopPropagation()
            onSelect(e, ev.metaKey || ev.ctrlKey)
          }}
          onDoubleClick={() => {
            if (e.isDir) toggle(e.path)
            else onActivate(e)
          }}
          onContextMenu={(ev) => onContextMenu(ev, e)}
          onDragStart={(ev) => onDragStart(ev, e)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') {
              if (e.isDir) toggle(e.path)
              else onActivate(e)
            }
          }}
        >
          <span className="sftp-trow-chevron">
            {e.isDir ? (
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
            {e.isDir ? <Folder size={14} /> : renderFileIcon(e.name, 14)}
          </span>
          <span className="sftp-trow-name" title={e.name}>
            {e.name}
          </span>
        </div>
        {e.isDir && isExpanded && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  return <div className="sftp-tree">{root.children.map((child) => renderNode(child, 0))}</div>
}
