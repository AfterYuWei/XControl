import { useEffect, useState } from 'react'
import {
  Server,
  FolderOpen,
  Inbox,
  FilePlus,
  FolderPlus,
  RefreshCw,
  Pencil,
  Trash2,
  Copy,
  FileEdit,
} from 'lucide-react'
import { Breadcrumb } from './Breadcrumb'
import { FileRow } from './FileRow'
import { FileTree } from './FileTree'
import { PaneTabs } from './PaneTabs'
import { PaneActions } from './PaneActions'
import { SftpContextMenu, type MenuItem } from './SftpContextMenu'
import { useSftpStore } from './storeContext'
import {
  parentPath,
  flattenEntries,
  dropAction,
  validateDrop,
  type SftpDropTarget,
  type PaneSide,
} from '@/store/sftp'
import type { SftpEntry } from '@/types/sftp'

interface FilePaneProps {
  pane: PaneSide
  onPickServer: () => void
}

export function FilePane({ pane, onPickServer }: FilePaneProps) {
  const store = useSftpStore()
  const activeDrag = store.dragSession
  const navigateStore = store.navigate
  const [ctx, setCtx] = useState<{ x: number; y: number; entry: SftpEntry | null } | null>(null)
  const [hoverTimer, setHoverTimer] = useState<ReturnType<typeof setTimeout> | null>(null)
  const [hoverPath, setHoverPath] = useState<string | null>(null)
  const [springOriginPath, setSpringOriginPath] = useState<string | null>(null)

  const tabs = pane === 'left' ? store.leftTabs : store.rightTabs
  const activeId = pane === 'left' ? store.activeLeftTabId : store.activeRightTabId
  const activeTab = tabs.find((t) => t.id === activeId)

  useEffect(() => {
    if (!activeDrag && springOriginPath) {
      navigateStore(pane, springOriginPath)
      setSpringOriginPath(null)
    }
  }, [activeDrag, navigateStore, pane, springOriginPath])

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

  const rawEntries = activeTab.entries
  const treeRoot = activeTab.tree

  const navigate = (p: string) => store.navigate(pane, p)
  const selectFn = (p: string, opts?: { additive?: boolean }) => store.select(pane, p, opts)
  const clearSel = () => store.clearSelection(pane)

  // List view: folders first then files, alphabetical. Prepend ".." when not
  // at root so users can double-click to go up.
  const sorted = [...rawEntries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh')
  })

  const upEntry: SftpEntry | null =
    path !== '/' && path !== ''
      ? { name: '..', path: parentPath(path), is_dir: true, size: 0, mod_time: '' }
      : null

  const openEntry = (entry: SftpEntry) => {
    if (entry.is_dir) {
      navigate(entry.path)
    } else {
      store.openEditor(pane, entry.path)
    }
  }

  const makeTarget = (destDir: string, kind: SftpDropTarget['kind']): SftpDropTarget | null =>
    activeTab.sessionId ? {
      pane,
      tabId: activeTab.id,
      sessionId: activeTab.sessionId,
      destDir,
      serverName: server.name,
      kind,
    } : null

  const copyModifier = (e: React.DragEvent) => e.ctrlKey || e.altKey

  const targetOver = (e: React.DragEvent, target: SftpDropTarget | null) => {
    if (!store.dragSession || !target) return
    e.preventDefault()
    const invalid = validateDrop(store.dragSession, target, copyModifier(e))
    e.dataTransfer.dropEffect = invalid ? 'none' : dropAction(store.dragSession, target, copyModifier(e))
    store.setDropTarget(invalid ? null : { ...target, copyModifier: copyModifier(e) })
  }

  const drop = async (e: React.DragEvent, target?: SftpDropTarget | null) => {
    if (!store.dragSession) return
    e.preventDefault()
    e.stopPropagation()
    if (hoverTimer) clearTimeout(hoverTimer)
    setHoverTimer(null)
    setHoverPath(null)
    setSpringOriginPath(null)
    if (target) store.setDropTarget(target)
    await store.commitDrop(copyModifier(e))
  }

  const folderOver = (e: React.DragEvent, entry: SftpEntry, kind: SftpDropTarget['kind'] = 'folder') => {
    e.stopPropagation()
    const target = makeTarget(entry.path, kind)
    targetOver(e, target)
    if (kind !== 'tree' && entry.name !== '..' && store.dragSession && hoverPath !== entry.path) {
      if (hoverTimer) clearTimeout(hoverTimer)
      setHoverPath(entry.path)
      const timer = setTimeout(() => {
        setSpringOriginPath((origin) => origin ?? path)
        navigate(entry.path)
        setHoverTimer(null)
      }, 700)
      setHoverTimer(timer)
    }
  }

  const startDrag = (e: React.DragEvent, entry: SftpEntry, candidates: SftpEntry[]) => {
    if (!activeTab.sessionId) {
      e.preventDefault()
      return
    }
    const entries = selected.has(entry.path) ? candidates.filter((item) => selected.has(item.path)) : [entry]
    if (!selected.has(entry.path)) selectFn(entry.path)
    store.beginDrag({ sourcePane: pane, sourceTabId: activeTab.id, sourceSessionId: activeTab.sessionId, entries })
    e.dataTransfer.setData('application/x-xcontrol-sftp', activeTab.id)
    e.dataTransfer.effectAllowed = 'copyMove'
    const ghost = document.createElement('div')
    ghost.className = 'sftp-drag-ghost'
    ghost.textContent = entries.length === 1 ? entries[0].name : `${entries[0].name} 等 ${entries.length} 项`
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 14, 14)
    setTimeout(() => ghost.remove(), 0)
  }

  // --- Context menu builders ---
  const fileMenuItems = (entry: SftpEntry): MenuItem[] => [
    { id: 'open', label: entry.is_dir ? '打开文件夹' : '打开', icon: <FolderOpen size={13} />, onClick: () => openEntry(entry) },
    // Only show "编辑" for files (not directories).
    ...(!entry.is_dir
      ? [
          {
            id: 'edit',
            label: '编辑',
            icon: <FileEdit size={13} />,
            onClick: () => store.openEditor(pane, entry.path),
          },
        ]
      : []),
    { id: 'd1', label: '', divider: true },
    { id: 'newFile', label: '新建文件', icon: <FilePlus size={13} />, onClick: () => store.openNewFileDialog(pane) },
    { id: 'newFolder', label: '新建文件夹', icon: <FolderPlus size={13} />, onClick: () => store.openNewFolderDialog(pane) },
    { id: 'd2', label: '', divider: true },
    { id: 'rename', label: '重命名', icon: <Pencil size={13} />, onClick: () => store.openRenameDialog(pane, entry) },
    { id: 'copy', label: '复制路径', icon: <Copy size={13} />, onClick: () => navigator.clipboard?.writeText(entry.path) },
    { id: 'd3', label: '', divider: true },
    { id: 'del', label: '删除', icon: <Trash2 size={13} />, danger: true, onClick: () => store.openDeleteConfirm(pane, [entry]) },
  ]

  const blankMenuItems = (): MenuItem[] => [
    { id: 'newFile', label: '新建文件', icon: <FilePlus size={13} />, onClick: () => store.openNewFileDialog(pane) },
    { id: 'newFolder', label: '新建文件夹', icon: <FolderPlus size={13} />, onClick: () => store.openNewFolderDialog(pane) },
    { id: 'd1', label: '', divider: true },
    { id: 'refresh', label: '刷新', icon: <RefreshCw size={13} />, onClick: () => navigate(path) },
  ]

  const handleRefresh = () => navigate(path)

  const renderListView = () => (
    <div
      className={`sftp-list ${store.dropTarget?.pane === pane && store.dropTarget.kind === 'current' ? 'drop-current' : ''}`}
      onDragOver={(e) => targetOver(e, makeTarget(path, 'current'))}
      onDrop={(e) => drop(e, makeTarget(path, 'current'))}
      onClick={() => clearSel()}
      onContextMenu={(e) => {
        // Only show context menu when clicking on empty area (not on file rows)
        if (e.target === e.currentTarget || (e.target as HTMLElement).closest('.sftp-list-empty')) {
          e.preventDefault()
          setCtx({ x: e.clientX, y: e.clientY, entry: null })
        }
      }}
    >
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
          isDropTarget={store.dropTarget?.pane === pane && store.dropTarget.destDir === upEntry.path}
          onSelect={(e) => {
            e.stopPropagation()
            // Single-click on ".." only selects; double-click to go up.
          }}
          onOpen={() => navigate(upEntry.path)}
          onContextMenu={(e) => e.preventDefault()}
          onDragStart={(e) => e.preventDefault()}
          onDragEnd={() => {}}
          onDragOver={(e) => folderOver(e, upEntry)}
          onDragLeave={() => store.setDropTarget(null)}
          onDrop={(e) => drop(e, makeTarget(upEntry.path, 'folder'))}
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
            dragging={store.dragSession?.sourceTabId === activeTab.id && store.dragSession.entries.some((item) => item.path === entry.path)}
            isDropTarget={entry.is_dir && store.dropTarget?.pane === pane && store.dropTarget.destDir === entry.path}
            onSelect={(e) => {
              e.stopPropagation()
              selectFn(entry.path, { additive: e.metaKey || e.ctrlKey })
            }}
            onOpen={() => openEntry(entry)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              // Don't select on right-click, only show context menu
              setCtx({ x: e.clientX, y: e.clientY, entry })
            }}
            onDragStart={(e) => {
              startDrag(e, entry, sorted)
            }}
            onDragEnd={() => store.cancelDrag()}
            onDragOver={entry.is_dir ? (e) => folderOver(e, entry) : undefined}
            onDragLeave={entry.is_dir ? () => {
              if (hoverTimer) clearTimeout(hoverTimer)
              setHoverTimer(null)
              setHoverPath(null)
              store.setDropTarget(null)
            } : undefined}
            onDrop={entry.is_dir ? (e) => drop(e, makeTarget(entry.path, 'folder')) : undefined}
          />
        ))
      )}
    </div>
  )

  const renderTreeView = () => (
    <div
      className={`sftp-list sftp-list-tree ${store.dropTarget?.pane === pane && store.dropTarget.kind === 'current' ? 'drop-current' : ''}`}
      onDragOver={(e) => targetOver(e, makeTarget(path, 'current'))}
      onDrop={(e) => drop(e, makeTarget(path, 'current'))}
      onClick={() => clearSel()}
      onContextMenu={(e) => {
        // Only show context menu when clicking on empty area
        if (e.target === e.currentTarget || (e.target as HTMLElement).closest('.sftp-list-empty')) {
          e.preventDefault()
          setCtx({ x: e.clientX, y: e.clientY, entry: null })
        }
      }}
    >
      {treeRoot ? (
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
            startDrag(e, entry, flattenEntries(treeRoot))
          }}
          onDragEnd={() => store.cancelDrag()}
          dropTargetPath={store.dropTarget?.pane === pane ? store.dropTarget.destDir : null}
          draggingPaths={store.dragSession?.sourceTabId === activeTab.id ? new Set(store.dragSession.entries.map((item) => item.path)) : undefined}
          onDragOverEntry={(e, entry) => folderOver(e, entry, 'tree')}
          onDragLeaveEntry={() => store.setDropTarget(null)}
          onDropEntry={(e, entry) => drop(e, makeTarget(entry.path, 'tree'))}
        />
      ) : (
        <div className="sftp-list-empty">
          <Inbox size={20} />
          <span>加载中...</span>
        </div>
      )}
    </div>
  )

  return (
    <div className="sftp-pane">
      <PaneTabs pane={pane} onPickServer={onPickServer} />

      <div className="sftp-crumb-row">
        <Breadcrumb
          path={path}
          onNavigate={navigate}
          dropTargetPath={store.dropTarget?.pane === pane ? store.dropTarget.destDir : null}
          onDragOverSegment={(e, segmentPath) => {
            e.stopPropagation()
            targetOver(e, makeTarget(segmentPath, 'breadcrumb'))
          }}
          onDropSegment={(e, segmentPath) => drop(e, makeTarget(segmentPath, 'breadcrumb'))}
        />
        <PaneActions
          view={view}
          showHidden={activeTab.showHidden}
          hasSelection={selected.size > 0}
          selectedCount={selected.size}
          onToggleView={() => store.toggleView(pane)}
          onToggleShowHidden={() => store.toggleShowHidden(pane)}
          onRefresh={handleRefresh}
          onNewFile={() => store.openNewFileDialog(pane)}
          onNewFolder={() => store.openNewFolderDialog(pane)}
          onRename={() => {
            const selectedPath = Array.from(selected)[0]
            const entry = activeTab.entries.find((e) => e.path === selectedPath)
            if (entry) store.openRenameDialog(pane, entry)
          }}
          onDelete={() => store.openDeleteConfirm(pane)}
          onCopyPath={() => {
            const selectedPath = Array.from(selected)[0]
            if (selectedPath) navigator.clipboard?.writeText(selectedPath)
          }}
        />
      </div>

      {view === 'list' ? renderListView() : renderTreeView()}

      {store.dragSession && store.dropTarget?.pane === pane && (
        <div className="sftp-drop-status">
          {dropAction(store.dragSession, store.dropTarget, Boolean(store.dropTarget.copyModifier)) === 'move' ? '移动' : '复制'} {store.dragSession.entries.length} 项到
          <strong>{store.dropTarget.serverName}:{store.dropTarget.destDir}</strong>
        </div>
      )}

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
