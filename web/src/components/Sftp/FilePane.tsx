import { useState } from 'react'
import { toast } from 'sonner'
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
  FolderInput,
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
  matchesDropTarget,
  normalizeDraggedEntries,
  validateDrop,
  type SftpDropTarget,
  type PaneSide,
} from '@/store/sftp'
import type { SftpEntry } from '@/types/sftp'

interface FilePaneProps {
  pane: PaneSide
  onPickServer: () => void
}

interface ExternalDropState {
  target: SftpDropTarget
  count: number
}

export function FilePane({ pane, onPickServer }: FilePaneProps) {
  const store = useSftpStore()
  const [ctx, setCtx] = useState<{ x: number; y: number; entry: SftpEntry | null } | null>(null)
  const [externalDrop, setExternalDrop] = useState<ExternalDropState | null>(null)

  const tabs = pane === 'left' ? store.leftTabs : store.rightTabs
  const activeId = pane === 'left' ? store.activeLeftTabId : store.activeRightTabId
  const activeTab = tabs.find((t) => t.id === activeId)
  const localSessionId = [...store.leftTabs, ...store.rightTabs]
    .find((tab) => tab.server.id === 'local' && tab.sessionId)?.sessionId ?? undefined

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
  const carriesNativeFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

  const targetOver = (e: React.DragEvent, target: SftpDropTarget | null) => {
    if (!target) return
    if (store.dragSession) {
      e.preventDefault()
      const invalid = validateDrop(store.dragSession, target, copyModifier(e))
      e.dataTransfer.dropEffect = invalid ? 'none' : dropAction(store.dragSession, target, copyModifier(e))
      store.setDropTarget(invalid ? null : { ...target, copyModifier: copyModifier(e) })
      return
    }
    if (carriesNativeFiles(e)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      const count = Array.from(e.dataTransfer.items).filter((item) => item.kind === 'file').length
        || e.dataTransfer.files.length
      setExternalDrop((current) => matchesDropTarget(current?.target ?? null, target.pane, target.tabId, target.kind, target.destDir)
        && current?.count === count
        ? current
        : { target, count })
    }
  }

  const drop = async (e: React.DragEvent, target?: SftpDropTarget | null) => {
    if (store.dragSession) {
      e.preventDefault()
      e.stopPropagation()
      if (target) store.setDropTarget(target)
      await store.commitDrop(copyModifier(e))
      return
    }
    if (!target || !carriesNativeFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    setExternalDrop(null)

    const fileList = Array.from(e.dataTransfer.files)
    const droppedFiles = fileList.length > 0
      ? fileList
      : Array.from(e.dataTransfer.items)
          .filter((item) => item.kind === 'file')
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null)
    if (droppedFiles.length === 0) return

    const desktopFileDrag = window.xcontrol?.fileDrag
    const apiPaths = desktopFileDrag
      ? droppedFiles.map((file) => desktopFileDrag.getApiPath(file)).filter(Boolean)
      : []
    if (localSessionId && apiPaths.length === droppedFiles.length) {
      await store.importExternalPaths(localSessionId, [...new Set(apiPaths)], target)
      return
    }
    const containsDirectory = Array.from(e.dataTransfer.items).some((item) => {
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
      return entry?.isDirectory === true
    })
    if (containsDirectory) {
      toast.warning('当前环境无法读取拖入的文件夹，请使用 Electron 桌面版')
      return
    }
    await store.uploadExternalFiles(droppedFiles, target)
  }

  const folderOver = (e: React.DragEvent, entry: SftpEntry, kind: SftpDropTarget['kind'] = 'folder') => {
    e.stopPropagation()
    targetOver(e, makeTarget(entry.path, kind))
  }

  const leaveList = (e: React.DragEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    if (store.dropTarget?.pane === pane) store.setDropTarget(null)
    setExternalDrop(null)
  }

  const startDrag = (e: React.DragEvent, entry: SftpEntry, candidates: SftpEntry[]) => {
    if (!activeTab.sessionId) {
      e.preventDefault()
      return
    }
    const entries = normalizeDraggedEntries(
      selected.has(entry.path) ? candidates.filter((item) => selected.has(item.path)) : [entry]
    )
    if (!selected.has(entry.path)) selectFn(entry.path)
    store.beginDrag({ sourcePane: pane, sourceTabId: activeTab.id, sourceSessionId: activeTab.sessionId, entries })
    e.dataTransfer.setData('application/x-xcontrol-sftp', activeTab.id)
    e.dataTransfer.effectAllowed = 'copyMove'
    const desktopFileDrag = window.xcontrol?.fileDrag
    if (desktopFileDrag && (server.id === 'local' || localSessionId)) {
      e.preventDefault()
      desktopFileDrag.start({
        sourceSessionId: activeTab.sessionId,
        localSessionId,
        sourceIsLocal: server.id === 'local',
        paths: entries.map((item) => item.path),
      })
      return
    }
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
  const handleCurrentDragOver = (e: React.DragEvent) => {
    // A directory row owns its whole hit area. Do not let the surrounding
    // list replace that destination with the current directory.
    if (e.target instanceof Element && e.target.closest('.sftp-row.is-dir, .sftp-trow.is-dir')) return
    targetOver(e, makeTarget(path, 'current'))
  }
  const handleCurrentDrop = (e: React.DragEvent) => drop(e, makeTarget(path, 'current'))
  const handleFolderDrop = (e: React.DragEvent, entry: SftpEntry) => drop(e, makeTarget(entry.path, 'folder'))
  const handleTreeFolderOver = (e: React.DragEvent, entry: SftpEntry) => folderOver(e, entry, 'tree')
  const handleTreeFolderDrop = (e: React.DragEvent, entry: SftpEntry) => drop(e, makeTarget(entry.path, 'tree'))
  const handleBreadcrumbOver = (e: React.DragEvent, segmentPath: string) => {
    e.stopPropagation()
    targetOver(e, makeTarget(segmentPath, 'breadcrumb'))
  }
  const handleBreadcrumbDrop = (e: React.DragEvent, segmentPath: string) =>
    drop(e, makeTarget(segmentPath, 'breadcrumb'))
  const visualDropTarget = store.dragSession ? store.dropTarget : externalDrop?.target ?? null

  const renderListView = () => (
    <div
      className="sftp-list"
      onDragOver={handleCurrentDragOver}
      onDragLeave={leaveList}
      onDrop={handleCurrentDrop}
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
          isDropTarget={matchesDropTarget(visualDropTarget, pane, activeTab.id, 'folder', upEntry.path)}
          onSelect={(e) => {
            e.stopPropagation()
            // Single-click on ".." only selects; double-click to go up.
          }}
          onOpen={() => navigate(upEntry.path)}
          onContextMenu={(e) => e.preventDefault()}
          onDragStart={(e) => e.preventDefault()}
          onDragEnd={() => {}}
          onDragOver={folderOver}
          onDrop={handleFolderDrop}
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
            isDropTarget={entry.is_dir
              && matchesDropTarget(visualDropTarget, pane, activeTab.id, 'folder', entry.path)}
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
            onDragOver={entry.is_dir ? folderOver : undefined}
            onDrop={entry.is_dir ? handleFolderDrop : undefined}
          />
        ))
      )}
    </div>
  )

  const renderTreeView = () => (
    <div
      className="sftp-list sftp-list-tree"
      onDragOver={handleCurrentDragOver}
      onDragLeave={leaveList}
      onDrop={handleCurrentDrop}
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
          dropTargetPath={matchesDropTarget(visualDropTarget, pane, activeTab.id, 'tree')
            ? visualDropTarget?.destDir
            : null}
          draggingPaths={store.dragSession?.sourceTabId === activeTab.id ? new Set(store.dragSession.entries.map((item) => item.path)) : undefined}
          onDragOverEntry={handleTreeFolderOver}
          onDropEntry={handleTreeFolderDrop}
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
          dropTargetPath={matchesDropTarget(visualDropTarget, pane, activeTab.id, 'breadcrumb')
            ? visualDropTarget?.destDir
            : null}
          onDragOverSegment={handleBreadcrumbOver}
          onDropSegment={handleBreadcrumbDrop}
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

      {store.dragSession && store.dropTarget?.pane === pane && (() => {
        const action = dropAction(store.dragSession, store.dropTarget, Boolean(store.dropTarget.copyModifier))
        const destinationType = store.dropTarget.kind === 'folder' || store.dropTarget.kind === 'tree'
          ? '放入文件夹'
          : store.dropTarget.kind === 'current'
            ? '放入当前文件夹'
            : '放入目录'
        return (
          <div className="sftp-drop-status" role="status" aria-live="polite">
            <span className="sftp-drop-status-action">
              {action === 'move' ? <FolderInput size={14} /> : <Copy size={14} />}
              {action === 'move' ? '移动' : '复制'}
            </span>
            <span>{store.dragSession.entries.length} 项 · {destinationType}</span>
            <strong title={`${store.dropTarget.serverName}:${store.dropTarget.destDir}`}>
              {store.dropTarget.serverName}:{store.dropTarget.destDir}
            </strong>
          </div>
        )
      })()}

      {!store.dragSession && externalDrop?.target.pane === pane && (
        <div className="sftp-drop-status" role="status" aria-live="polite">
          <span className="sftp-drop-status-action"><Copy size={14} />复制</span>
          <span>{externalDrop.count} 项 · {externalDrop.target.kind === 'current' ? '放入当前文件夹' : '放入文件夹'}</span>
          <strong title={`${externalDrop.target.serverName}:${externalDrop.target.destDir}`}>
            {externalDrop.target.serverName}:{externalDrop.target.destDir}
          </strong>
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
