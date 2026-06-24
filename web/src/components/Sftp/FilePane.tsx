import { useState } from 'react'
import {
  FolderUp,
  Server,
  FolderOpen,
  Inbox,
  FolderPlus,
  RefreshCw,
  Pencil,
  Trash2,
  Copy,
} from 'lucide-react'
import { Breadcrumb } from './Breadcrumb'
import { FileRow } from './FileRow'
import { FileTree } from './FileTree'
import { PaneTabs } from './PaneTabs'
import { PaneActions } from './PaneActions'
import { SftpContextMenu, type MenuItem } from './SftpContextMenu'
import { useSftpStore } from './storeContext'
import {
  listFor,
  parentPath,
  treeFor,
  type PaneSide,
} from '@/store/sftp'
import type { SftpEntry } from '@/types/sftp'

interface FilePaneProps {
  pane: PaneSide
  onPickServer: () => void
}

export function FilePane({ pane, onPickServer }: FilePaneProps) {
  const store = useSftpStore()
  const [dragOver, setDragOver] = useState(false)
  const [ctx, setCtx] = useState<{ x: number; y: number; entry: SftpEntry | null } | null>(null)

  const tabs = pane === 'left' ? store.leftTabs : store.rightTabs
  const activeId = pane === 'left' ? store.activeLeftTabId : store.activeRightTabId
  const activeTab = tabs.find((t) => t.id === activeId)

  // --- Empty state: no server connected yet in this pane. ---
  if (!activeTab) {
    return (
      <div className="sftp-pane sftp-pane-empty">
        <div className="sftp-pane-empty-body">
          <div className="sftp-pane-empty-icon">
            <Server size={28} />
          </div>
          <div className="sftp-pane-empty-title">未连接服务器</div>
          <div className="sftp-pane-empty-desc">点击下方按钮选择一台服务器，即可浏览其文件系统</div>
          <button className="sftp-pane-empty-btn" onClick={onPickServer}>
            <Server size={14} /> 选择服务器
          </button>
        </div>
      </div>
    )
  }

  const server = activeTab.server
  const path = activeTab.path
  const view = activeTab.view
  const selected = activeTab.selected

  const rawEntries = listFor(server, path)
  const treeRoot = treeFor(server)

  const navigate = (p: string) => store.navigate(pane, p)
  const selectFn = (p: string, opts?: { additive?: boolean }) => store.select(pane, p, opts)
  const clearSel = () => store.clearSelection(pane)

  // List view: folders first then files, alphabetical. Prepend ".." when not
  // at root so users can double-click to go up.
  const sorted = [...rawEntries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh')
  })

  const upEntry: SftpEntry | null =
    path !== '/' && path !== ''
      ? { name: '..', path: parentPath(path), isDir: true, size: 0, modTime: '' }
      : null

  const openEntry = (entry: SftpEntry) => {
    if (entry.isDir) navigate(entry.path)
  }

  // --- Drag & drop (cross-pane file transfer). Direction is derived from
  //     source vs target pane: dropping onto the *other* pane transfers. ---
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const raw = e.dataTransfer.getData('application/sftp-entry')
    if (!raw) return
    try {
      const { entries: dropped, from }: { entries: SftpEntry[]; from: PaneSide } = JSON.parse(raw)
      if (from === pane) return // same pane, no transfer
      const direction: 'upload' | 'download' = from === 'left' ? 'upload' : 'download'
      const files = dropped.filter((d) => !d.isDir)
      if (files.length) store.startTransfer(files, direction)
    } catch {
      /* ignore malformed drag payload */
    }
  }

  // --- Context menu builders ---
  const fileMenuItems = (entry: SftpEntry): MenuItem[] => [
    { id: 'open', label: entry.isDir ? '打开文件夹' : '打开', icon: <FolderOpen size={13} />, onClick: () => openEntry(entry) },
    { id: 'd1', label: '', divider: true },
    { id: 'rename', label: '重命名', icon: <Pencil size={13} />, onClick: () => {} },
    { id: 'copy', label: '复制路径', icon: <Copy size={13} />, onClick: () => navigator.clipboard?.writeText(entry.path) },
    { id: 'd2', label: '', divider: true },
    { id: 'del', label: '删除', icon: <Trash2 size={13} />, danger: true, onClick: () => {} },
  ]

  const blankMenuItems = (): MenuItem[] => [
    { id: 'mkdir', label: '新建文件夹', icon: <FolderPlus size={13} />, onClick: () => {} },
    { id: 'refresh', label: '刷新', icon: <RefreshCw size={13} />, onClick: () => navigate(path) },
  ]

  const handleRefresh = () => navigate(path)

  const renderListView = () => (
    <div className="sftp-list" onClick={() => clearSel()}>
      {dragOver && (
        <div className="sftp-drop-hint">
          <FolderUp size={18} />
          <span>释放以传输到{server.name}</span>
        </div>
      )}

      <div className="sftp-list-head">
        <span className="sftp-cell sftp-cell-icon" />
        <span className="sftp-cell sftp-cell-name">名称</span>
        <span className="sftp-cell sftp-cell-size">大小</span>
        <span className="sftp-cell sftp-cell-date">修改时间</span>
      </div>

      {upEntry && (
        <FileRow
          key=".."
          entry={upEntry}
          selected={false}
          dragging={false}
          isDropTarget={false}
          onSelect={(e) => {
            e.stopPropagation()
            // Single-click on ".." only selects; double-click to go up.
          }}
          onOpen={() => navigate(upEntry.path)}
          onContextMenu={(e) => e.preventDefault()}
          onDragStart={(e) => e.preventDefault()}
          onDragEnd={() => {}}
        />
      )}

      {sorted.length === 0 && !upEntry ? (
        <div className="sftp-list-empty">
          <Inbox size={20} />
          <span>空文件夹</span>
        </div>
      ) : (
        sorted.map((entry) => (
          <FileRow
            key={entry.path}
            entry={entry}
            selected={selected.has(entry.path)}
            dragging={false}
            isDropTarget={false}
            onSelect={(e) => {
              e.stopPropagation()
              selectFn(entry.path, { additive: e.metaKey || e.ctrlKey })
            }}
            onOpen={() => openEntry(entry)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (!selected.has(entry.path)) selectFn(entry.path)
              setCtx({ x: e.clientX, y: e.clientY, entry })
            }}
            onDragStart={(e) => {
              const sel = selected.has(entry.path) ? sorted.filter((s) => selected.has(s.path)) : [entry]
              e.dataTransfer.setData(
                'application/sftp-entry',
                JSON.stringify({ entries: sel, from: pane })
              )
              e.dataTransfer.effectAllowed = 'copyMove'
            }}
            onDragEnd={() => {}}
          />
        ))
      )}
    </div>
  )

  const renderTreeView = () => (
    <div className="sftp-list sftp-list-tree" onClick={() => clearSel()}>
      {dragOver && (
        <div className="sftp-drop-hint">
          <FolderUp size={18} />
          <span>释放以传输到{server.name}</span>
        </div>
      )}
      <FileTree
        root={treeRoot}
        activePath={path}
        selected={selected}
        pane={pane}
        onSelect={(entry, additive) => selectFn(entry.path, { additive })}
        onActivate={(entry) => openEntry(entry)}
        onContextMenu={(e, entry) => {
          e.preventDefault()
          e.stopPropagation()
          if (!selected.has(entry.path)) selectFn(entry.path)
          setCtx({ x: e.clientX, y: e.clientY, entry })
        }}
        onDragStart={(e, entry) => {
          e.dataTransfer.setData(
            'application/sftp-entry',
            JSON.stringify({ entries: [entry], from: pane })
          )
          e.dataTransfer.effectAllowed = 'copyMove'
        }}
      />
    </div>
  )

  return (
    <div
      className={`sftp-pane ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
      }}
      onDrop={handleDrop}
      onContextMenu={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
          setCtx({ x: e.clientX, y: e.clientY, entry: null })
        }
      }}
    >
      <PaneTabs pane={pane} onPickServer={onPickServer} />

      <div className="sftp-crumb-row">
        <Breadcrumb path={path} onNavigate={navigate} />
        <PaneActions
          view={view}
          hasSelection={selected.size > 0}
          onToggleView={() => store.toggleView(pane)}
          onRefresh={handleRefresh}
        />
      </div>

      {view === 'list' ? renderListView() : renderTreeView()}

      {ctx && (
        <SftpContextMenu
          x={ctx.x}
          y={ctx.y}
          items={ctx.entry ? fileMenuItems(ctx.entry) : blankMenuItems()}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  )
}
