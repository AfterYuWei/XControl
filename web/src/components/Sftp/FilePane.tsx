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
  Upload,
  Download,
} from 'lucide-react'
import { Breadcrumb } from './Breadcrumb'
import { FileRow } from './FileRow'
import { FileTree } from './FileTree'
import { PaneTabs } from './PaneTabs'
import { PaneActions } from './PaneActions'
import { SftpContextMenu, type MenuItem } from './SftpContextMenu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useSftpStore, useSftpStoreApi } from './storeContext'
import {
  parentPath,
  flattenEntries,
  dropAction,
  validateDrop,
  matchesDropTarget,
  normalizeDraggedEntries,
  type SftpDragSession,
  type SftpDropTarget,
  type PaneSide,
} from '@/store/sftp'
import { usePointerDrag } from '@/hooks/usePointerDrag'
import { dropPayloadAttr, hitTestDropTarget } from '@/lib/dragRegistry'
import { isTauri, sftpDragOut, startNativeFileDrag } from '@/lib/desktop'
import { getPlatformCapabilities, isMobileRuntime } from '@/lib/platform'
import { documentApi } from '@/api/document'
import { sftpApi } from '@/api/sftp'
import type { SftpEntry } from '@/types/sftp'

interface FilePaneProps {
  pane: PaneSide
  onPickServer: () => void
}

interface ExternalDropState {
  target: SftpDropTarget
  count: number
}

/** 拖出准备的 toast id（loading/错误复用同一 id 以便覆盖更新）。 */
const DRAG_OUT_TOAST = 'sftp-drag-out'

export function FilePane({ pane, onPickServer }: FilePaneProps) {
  const mobile = isMobileRuntime()
  const store = useSftpStore()
  // store API（非响应式）：事件回调中读取最新状态，替代渲染期写 ref
  const api = useSftpStoreApi()
  const [ctx, setCtx] = useState<{ x: number; y: number; entry: SftpEntry | null } | null>(null)
  const [externalDrop, setExternalDrop] = useState<ExternalDropState | null>(null)
  const [documentBusy, setDocumentBusy] = useState(false)
  const [mobileTransfer, setMobileTransfer] = useState<'copy' | 'move' | null>(null)
  const [mobileTargetId, setMobileTargetId] = useState('')
  const [mobileDestDir, setMobileDestDir] = useState('/')

  const tabs = pane === 'left' ? store.leftTabs : store.rightTabs
  const activeId = pane === 'left' ? store.activeLeftTabId : store.activeRightTabId
  const activeTab = tabs.find((t) => t.id === activeId)

  /** 桌面端拖出到系统：物化远程文件（Rust）→ 原生拖拽（插件）。 */
  const runDragOut = async (sourceSessionId: string, paths: string[]) => {
    const state = api.getState()
    const localSessionId = [...state.leftTabs, ...state.rightTabs]
      .find((tab) => tab.server.id === 'local' && tab.sessionId)?.sessionId
    if (!localSessionId) {
      toast.error('本机文件会话尚未连接，无法拖出远程文件')
      return
    }
    toast.loading('正在准备远程文件…', { id: DRAG_OUT_TOAST })
    try {
      const { files, icon } = await sftpDragOut(sourceSessionId, localSessionId, paths)
      toast.dismiss(DRAG_OUT_TOAST)
      await startNativeFileDrag(files, icon)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '拖出文件准备失败', { id: DRAG_OUT_TOAST })
    } finally {
      api.getState().cancelDrag()
    }
  }

  // ─── 指针拖拽引擎（替代 HTML5 DnD） ──────────────────────────────────────
  // 注意：hook 必须在下方 early return 之前调用；回调经 stateRef 空安全
  const drag = usePointerDrag<SftpDragSession>({
    ghostLabel: (session) =>
      session.entries.length === 1
        ? session.entries[0].name
        : `${session.entries[0].name} 等 ${session.entries.length} 项`,
    onActivate: (session) => {
      const state = api.getState()
      // 拖动单个未选中项时同步选中（对齐原 HTML5 startDrag 行为）：
      // entries.length === 1 仅出现在「未选中即拖」或「唯一选中项」两种情况
      if (session.entries.length === 1) state.select(pane, session.entries[0].path)
      state.beginDrag(session)
    },
    onOver: (_session, payload, copyModifier) => {
      const state = api.getState()
      if (!state.dragSession) return
      const target = payload?.kind === 'sftp' ? payload.target : null
      if (!target) {
        if (state.dropTarget) state.setDropTarget(null)
        return
      }
      const invalid = validateDrop(state.dragSession, target, copyModifier)
      state.setDropTarget(invalid ? null : { ...target, copyModifier: copyModifier })
    },
    onDrop: async (_session, payload, copyModifier) => {
      if (payload.kind !== 'sftp') return
      const state = api.getState()
      state.setDropTarget(payload.target)
      await state.commitDrop(copyModifier)
    },
    onCancel: () => api.getState().cancelDrag(),
    // 光标拖出窗口：桌面端移交原生文件拖拽（浏览器忽略，维持内部拖拽语义）
    onLeaveWindow: (session) => {
      if (!getPlatformCapabilities().dragOut) return false
      void runDragOut(session.sourceSessionId, session.entries.map((entry) => entry.path))
      return true
    },
  })

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
          <Button type="button" variant="outline" className="sftp-pane-empty-btn" onClick={onPickServer}>
            <Server size={14} /> 选择服务器
          </Button>
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

  /** 由拖拽条目构造会话（选中集优先，单个未选中项拖动时仅含自身）。 */
  const buildDragSession = (entry: SftpEntry, candidates: SftpEntry[]): SftpDragSession | null => {
    if (!activeTab.sessionId) return null
    const entries = selected.has(entry.path)
      ? candidates.filter((item) => selected.has(item.path))
      : [entry]
    return {
      sourcePane: pane,
      sourceTabId: activeTab.id,
      sourceSessionId: activeTab.sessionId,
      entries: normalizeDraggedEntries(entries),
    }
  }

  // ─── 浏览器模式：HTML5 外部文件拖入（桌面端由 useExternalDrop + Tauri 事件接管） ────
  const carriesNativeFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

  const externalOver = (e: React.DragEvent) => {
    if (isTauri() || !carriesNativeFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const hit = hitTestDropTarget(e.clientX, e.clientY)
    if (hit?.kind !== 'sftp') {
      setExternalDrop(null)
      return
    }
    const count =
      Array.from(e.dataTransfer.items).filter((item) => item.kind === 'file').length
      || e.dataTransfer.files.length
    setExternalDrop((current) =>
      matchesDropTarget(current?.target ?? null, hit.target.pane, hit.target.tabId, hit.target.kind, hit.target.destDir)
        && current?.count === count
        ? current
        : { target: hit.target, count },
    )
  }

  const externalDropHandler = async (e: React.DragEvent) => {
    if (isTauri() || !carriesNativeFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    setExternalDrop(null)

    const droppedFiles = Array.from(e.dataTransfer.files)
    if (droppedFiles.length === 0) return
    const hit = hitTestDropTarget(e.clientX, e.clientY)
    const target = hit?.kind === 'sftp' ? hit.target : makeTarget(path, 'current')
    if (!target) return
    const containsDirectory = Array.from(e.dataTransfer.items).some((item) => {
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
      return entry?.isDirectory === true
    })
    if (containsDirectory) {
      toast.warning('当前环境无法读取拖入的文件夹，请使用桌面版')
      return
    }
    await store.uploadExternalFiles(droppedFiles, target)
  }

  const leaveList = (e: React.DragEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    setExternalDrop(null)
  }

  // 拖放高亮：内部拖拽用 store.dropTarget；外部拖入桌面端用 store.externalHover、浏览器用局部 externalDrop
  const externalVisual = store.externalHover ?? externalDrop
  const visualDropTarget = store.dragSession ? store.dropTarget : externalVisual?.target ?? null

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
    // 桌面端拖出兜底入口（拖拽手势之外的显式导出）
    ...(getPlatformCapabilities().dragOut
      ? [
          {
            id: 'dragout',
            label: '导出到本机…',
            icon: <FolderInput size={13} />,
            onClick: () => {
              const paths = selected.has(entry.path) ? Array.from(selected) : [entry.path]
              void runDragOut(activeTab.sessionId!, paths)
            },
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
  const handleDocumentUpload = async () => {
    if (!activeTab.sessionId) return
    setDocumentBusy(true)
    const documents = await documentApi.pick(true).catch((error) => {
      toast.error(error instanceof Error ? error.message : '选择文件失败')
      return []
    })
    try {
      for (const document of documents) {
        const response = await sftpApi.uploadDocument(activeTab.sessionId, document.reference, path)
        api.setState((state) => ({ transfers: [...state.transfers, ...response.tasks] }))
      }
      if (documents.length) {
        toast.success(`已上传 ${documents.length} 个文件`)
        await store.refresh(pane)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '上传失败')
    } finally {
      await Promise.all(documents.map((document) => documentApi.release(document.reference).catch(() => undefined)))
      setDocumentBusy(false)
    }
  }
  const handleDocumentDownload = async () => {
    if (!activeTab.sessionId || selected.size === 0) return
    setDocumentBusy(true)
    try {
      await sftpApi.downloadToDocuments(activeTab.sessionId, Array.from(selected))
      toast.success('文件已保存到所选位置')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '下载失败')
    } finally {
      setDocumentBusy(false)
    }
  }
  const transferTargets = [
    ...store.leftTabs.map((tab) => ({ ...tab, pane: 'left' as const })),
    ...store.rightTabs.map((tab) => ({ ...tab, pane: 'right' as const })),
  ].filter((tab) => tab.sessionId && (
    mobileTransfer === 'move' ? tab.sessionId === activeTab.sessionId : tab.id !== activeTab.id
  ))

  const openMobileTransfer = (action: 'copy' | 'move') => {
    if (!activeTab.sessionId || selected.size === 0) return
    const targets = [
      ...store.leftTabs.map((tab) => ({ ...tab, pane: 'left' as const })),
      ...store.rightTabs.map((tab) => ({ ...tab, pane: 'right' as const })),
    ].filter((tab) => tab.sessionId && (
      action === 'move' ? tab.sessionId === activeTab.sessionId : tab.id !== activeTab.id
    ))
    setMobileTransfer(action)
    setMobileTargetId(action === 'move' ? activeTab.id : (targets[0]?.id ?? ''))
    setMobileDestDir(path)
  }

  const commitMobileTransfer = async () => {
    if (!mobileTransfer || !activeTab.sessionId) return
    const target = transferTargets.find((tab) => tab.id === mobileTargetId)
    if (!target?.sessionId) return
    const paths = Array.from(selected)
    setDocumentBusy(true)
    try {
      if (mobileTransfer === 'move') {
        if (target.sessionId !== activeTab.sessionId) {
          throw new Error('跨服务器请使用“复制到”，移动仅支持同一服务器')
        }
        await sftpApi.move(activeTab.sessionId, paths, mobileDestDir, 'rename')
        await store.refresh(pane)
        toast.success('移动完成')
      } else {
        const response = await sftpApi.transfer(
          activeTab.sessionId,
          target.sessionId,
          paths,
          mobileDestDir,
          'rename',
          paths.some((selectedPath) => activeTab.entries.find((entry) => entry.path === selectedPath)?.is_dir)
            ? 'archive'
            : 'preserve',
        )
        if (response.tasks?.length) {
          api.setState((state) => ({ transfers: [...state.transfers, ...response.tasks!] }))
        }
        toast.success('跨服务器传输已开始')
      }
      setMobileTransfer(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '文件操作失败')
    } finally {
      setDocumentBusy(false)
    }
  }
  const currentTarget = makeTarget(path, 'current')
  const listContainerProps = {
    'data-drag-payload': currentTarget ? dropPayloadAttr({ kind: 'sftp', target: currentTarget }) : undefined,
    onDragOver: externalOver,
    onDragLeave: leaveList,
    onDrop: externalDropHandler,
  }

  const renderListView = () => (
    <div
      className="sftp-list"
      {...listContainerProps}
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
            if (mobile) navigate(upEntry.path)
          }}
          onOpen={() => navigate(upEntry.path)}
          onContextMenu={(e) => e.preventDefault()}
          onRowPointerDown={() => {}}
          dropTarget={makeTarget(upEntry.path, 'folder')}
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
              if (mobile && entry.is_dir) openEntry(entry)
              else selectFn(entry.path, { additive: e.metaKey || e.ctrlKey })
            }}
            onOpen={() => openEntry(entry)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              // Don't select on right-click, only show context menu
              setCtx({ x: e.clientX, y: e.clientY, entry })
            }}
            onRowPointerDown={(e) => {
              const session = buildDragSession(entry, sorted)
              if (session) drag.start(e, session)
            }}
            dropTarget={entry.is_dir ? makeTarget(entry.path, 'folder') : null}
          />
        ))
      )}
    </div>
  )

  const renderTreeView = () => (
    <div
      className="sftp-list sftp-list-tree"
      {...listContainerProps}
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
          onSelect={(entry, additive) => selectFn(entry.path, { additive })}
          onActivate={(entry) => openEntry(entry)}
          onContextMenu={(e, entry) => {
            e.preventDefault()
            e.stopPropagation()
            if (!selected.has(entry.path)) selectFn(entry.path)
            setCtx({ x: e.clientX, y: e.clientY, entry })
          }}
          onRowPointerDown={(e, entry) => {
            const session = buildDragSession(entry, flattenEntries(treeRoot))
            if (session) drag.start(e, session)
          }}
          dropTargetPath={matchesDropTarget(visualDropTarget, pane, activeTab.id, 'tree')
            ? visualDropTarget?.destDir
            : null}
          draggingPaths={store.dragSession?.sourceTabId === activeTab.id ? new Set(store.dragSession.entries.map((item) => item.path)) : undefined}
          makeDropTarget={(entry) => makeTarget(entry.path, 'tree')}
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
      {mobile && (
        <div className="sftp-mobile-actions">
          <Button variant="outline" disabled={documentBusy || !activeTab.sessionId} onClick={() => void handleDocumentUpload()}>
            <Upload size={16} /> 上传
          </Button>
          <Button variant="outline" disabled={documentBusy || !activeTab.sessionId || selected.size === 0} onClick={() => void handleDocumentDownload()}>
            <Download size={16} /> 下载
          </Button>
          <Button variant="outline" disabled={documentBusy || !activeTab.sessionId || selected.size === 0} onClick={() => openMobileTransfer('copy')}>
            <Copy size={16} /> 复制到
          </Button>
          <Button variant="outline" disabled={documentBusy || !activeTab.sessionId || selected.size === 0} onClick={() => openMobileTransfer('move')}>
            <FolderInput size={16} /> 移动到
          </Button>
        </div>
      )}
      <PaneTabs pane={pane} onPickServer={onPickServer} />

      <div className="sftp-crumb-row">
        <Breadcrumb
          path={path}
          onNavigate={navigate}
          dropTargetPath={matchesDropTarget(visualDropTarget, pane, activeTab.id, 'breadcrumb')
            ? visualDropTarget?.destDir
            : null}
          makeDropTarget={(segmentPath) => makeTarget(segmentPath, 'breadcrumb')}
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

      {!store.dragSession && externalVisual?.target.pane === pane && (
        <div className="sftp-drop-status" role="status" aria-live="polite">
          <span className="sftp-drop-status-action"><Copy size={14} />复制</span>
          <span>{externalVisual.count} 项 · {externalVisual.target.kind === 'current' ? '放入当前文件夹' : '放入文件夹'}</span>
          <strong title={`${externalVisual.target.serverName}:${externalVisual.target.destDir}`}>
            {externalVisual.target.serverName}:{externalVisual.target.destDir}
          </strong>
        </div>
      )}

      <Dialog open={mobileTransfer !== null} onOpenChange={(open) => !open && setMobileTransfer(null)}>
        <DialogContent className="w-[min(440px,calc(100vw-2rem))]">
          <DialogTitle>{mobileTransfer === 'move' ? '移动所选项目' : '复制/跨服务器传输'}</DialogTitle>
          <DialogDescription>选择目标会话与目录；同名文件将自动重命名。</DialogDescription>
          <label className="space-y-1.5 text-sm">
            <span>目标会话</span>
            <select
              className="h-11 w-full rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg-input)] px-3"
              value={mobileTargetId}
              onChange={(event) => setMobileTargetId(event.target.value)}
            >
              {transferTargets.map((target) => (
                <option key={target.id} value={target.id}>{target.server.name} · {target.path}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5 text-sm">
            <span>目标目录</span>
            <Input value={mobileDestDir} onChange={(event) => setMobileDestDir(event.target.value)} />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setMobileTransfer(null)}>取消</Button>
            <Button disabled={!mobileTargetId || !mobileDestDir.startsWith('/')} onClick={() => void commitMobileTransfer()}>确认</Button>
          </div>
        </DialogContent>
      </Dialog>

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
