import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileArchive,
  FileCode,
  FileImage,
  FilePlus,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { MobileSheet, type MobileSheetItem } from '@/components/MobileLayout/MobileSheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { documentApi, type DocumentDescriptor } from '@/api/document'
import { groupApi } from '@/api/group'
import { sftpApi } from '@/api/sftp'
import { writeClipboardText } from '@/lib/clipboard'
import { parentPath, type PaneSide, type SftpTab } from '@/store/sftp'
import {
  isEditableMobileSftpEntry,
  isWithinMobileLongPressSlop,
  mobileDestinationError,
  MOBILE_SFTP_LONG_PRESS_MS,
  summarizeMobileTransfers,
  type MobileDirectoryAction,
} from '@/lib/mobileSftp'
import type { Group } from '@/types/group'
import type { ConflictResolution, SftpEntry, TransferTask } from '@/types/sftp'
import { useSftpStore, useSftpStoreApi } from './storeContext'

let activeMobileSftpPane: PaneSide = 'right'

function joinPath(dir: string, name: string) {
  return dir === '/' ? `/${name}` : `${dir.replace(/\/$/, '')}/${name}`
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDate(value: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function fileIcon(entry: SftpEntry) {
  if (entry.is_dir) return <Folder size={20} />
  const name = entry.name.toLowerCase()
  if (/\.(png|jpe?g|gif|svg|webp|heic)$/.test(name)) return <FileImage size={20} />
  if (/\.(zip|tar|gz|rar|7z|bz2|xz)$/.test(name)) return <FileArchive size={20} />
  if (isEditableMobileSftpEntry(entry)) return <FileCode size={20} />
  return <FileText size={20} />
}

interface MobileSftpViewProps {
  pane?: PaneSide
  onPickServer: () => void
  showTransferSummary?: boolean
}

export function MobileSftpView({ pane = 'right', onPickServer, showTransferSummary = true }: MobileSftpViewProps) {
  const store = useSftpStore()
  const api = useSftpStoreApi()
  const rootRef = useRef<HTMLDivElement>(null)
  const tabs = pane === 'left' ? store.leftTabs : store.rightTabs
  const activeId = pane === 'left' ? store.activeLeftTabId : store.activeRightTabId
  const activeTab = tabs.find((tab) => tab.id === activeId)
  const [selectionMode, setSelectionMode] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [serversOpen, setServersOpen] = useState(false)
  const [detailEntry, setDetailEntry] = useState<SftpEntry | null>(null)
  const [directoryAction, setDirectoryAction] = useState<MobileDirectoryAction | null>(null)
  const [transferOpen, setTransferOpen] = useState(false)
  const [documentBusy, setDocumentBusy] = useState(false)
  const [uploadPending, setUploadPending] = useState<{ documents: DocumentDescriptor[]; conflicts: number } | null>(null)

  const selectedEntries = useMemo(
    () => activeTab?.entries.filter((entry) => activeTab.selected.has(entry.path)) ?? [],
    [activeTab],
  )

  useEffect(() => {
    const handleBack = (event: Event) => {
      // TerminalView keeps inactive tabs mounted with a `.hidden` ancestor.
      // Only the visible SFTP surface may consume the page-level Android back event.
      if (!rootRef.current || rootRef.current.closest('.hidden')) return
      if (pane !== activeMobileSftpPane || event.defaultPrevented) return
      if (selectionMode && activeTab) {
        event.preventDefault()
        store.clearSelection(pane)
        setSelectionMode(false)
        return
      }
      if (activeTab && activeTab.path !== '/') {
        event.preventDefault()
        void store.navigate(pane, parentPath(activeTab.path))
      }
    }
    document.addEventListener('eizhu:mobile-sftp-back', handleBack)
    return () => document.removeEventListener('eizhu:mobile-sftp-back', handleBack)
  }, [activeTab, pane, selectionMode, store])

  const download = async (entries: SftpEntry[]) => {
    if (!activeTab?.sessionId || entries.length === 0) return
    setDocumentBusy(true)
    try {
      await sftpApi.downloadToDocuments(
        activeTab.sessionId,
        entries.map((entry) => entry.path),
        (tasks) => api.setState((state) => ({ transfers: mergeTransfers(state.transfers, tasks) })),
        (task) => api.setState((state) => ({ transfers: mergeTransfers(state.transfers, [task]) })),
      )
      toast.success('文件已保存到所选位置')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '下载失败')
    } finally {
      setDocumentBusy(false)
    }
  }

  const uploadDocuments = async (documents: DocumentDescriptor[], resolution: ConflictResolution) => {
    if (!activeTab?.sessionId) return
    setUploadPending(null)
    setDocumentBusy(true)
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index]
      try {
        const response = await sftpApi.uploadDocument(
          activeTab.sessionId,
          document.reference,
          activeTab.path,
          resolution,
        )
        api.setState((state) => ({ transfers: mergeTransfers(state.transfers, response.tasks) }))
      } catch (error) {
        const code = (error as { error?: { code?: string } })?.error?.code
        if (code === 'PATH_EXISTS' && resolution === 'ask') {
          setUploadPending({ documents: documents.slice(index), conflicts: 1 })
          setDocumentBusy(false)
          return
        }
        await Promise.all(
          documents.slice(index + 1).map((item) => documentApi.release(item.reference).catch(() => undefined)),
        )
        toast.error(error instanceof Error ? error.message : '上传失败')
        setDocumentBusy(false)
        return
      }
    }
    await store.refresh(pane)
    setDocumentBusy(false)
    toast.success(resolution === 'skip' ? '上传完成，已跳过同名文件' : '上传完成')
  }

  const beginUpload = async () => {
    if (!activeTab?.sessionId) return
    setDocumentBusy(true)
    const documents = await documentApi.pick(true).catch((error) => {
      toast.error(error instanceof Error ? error.message : '选择文件失败')
      return []
    })
    if (documents.length === 0) {
      setDocumentBusy(false)
      return
    }
    const conflicts = await Promise.all(documents.map(async (document) => {
      try {
        await sftpApi.stat(activeTab.sessionId!, joinPath(activeTab.path, document.name))
        return true
      } catch {
        return false
      }
    }))
    const conflictCount = conflicts.filter(Boolean).length
    setDocumentBusy(false)
    if (conflictCount > 0) {
      setUploadPending({ documents, conflicts: conflictCount })
      return
    }
    await uploadDocuments(documents, 'ask')
  }

  const cancelUploadConflict = async () => {
    const pending = uploadPending
    setUploadPending(null)
    if (pending) {
      await Promise.all(pending.documents.map((item) => documentApi.release(item.reference).catch(() => undefined)))
    }
  }

  const openEntry = (entry: SftpEntry) => {
    if (!activeTab) return
    if (entry.is_dir) {
      void store.navigate(pane, entry.path)
    } else if (isEditableMobileSftpEntry(entry)) {
      void store.openEditor(pane, entry.path)
    } else {
      setDetailEntry(entry)
    }
  }

  const enterSelection = (entry?: SftpEntry) => {
    if (!activeTab) return
    setSelectionMode(true)
    if (entry) store.select(pane, entry.path)
  }

  if (!activeTab) {
    return (
      <div ref={rootRef} className="msftp-root msftp-empty" onPointerDown={() => { activeMobileSftpPane = pane }}>
        <div className="msftp-empty-icon"><Server size={30} /></div>
        <strong>连接服务器以浏览文件</strong>
        <p>移动端通过远程会话管理文件，本机文件使用系统选择器上传或下载。</p>
        <Button className="msftp-primary" onClick={() => setServersOpen(true)}>
          <Server size={17} /> 选择服务器
        </Button>
        <ServerSheet open={serversOpen} onOpenChange={setServersOpen} pane={pane} onFallbackPicker={onPickServer} />
      </div>
    )
  }

  const headerActions: MobileSheetItem[] = [
    { id: 'upload', label: '上传文件', icon: Upload, onSelect: () => void beginUpload() },
    { id: 'new-folder', label: '新建文件夹', icon: FolderPlus, onSelect: () => store.openNewFolderDialog(pane) },
    { id: 'new-file', label: '新建文件', icon: FilePlus, onSelect: () => store.openNewFileDialog(pane) },
    { id: 'select', label: '选择项目', icon: CheckCircle2, onSelect: () => enterSelection() },
    { id: 'refresh', label: '刷新', icon: RefreshCw, onSelect: () => void store.refresh(pane) },
    {
      id: 'hidden',
      label: activeTab.showHidden ? '隐藏点文件' : '显示隐藏文件',
      icon: activeTab.showHidden ? EyeOff : Eye,
      onSelect: () => void store.toggleShowHidden(pane),
    },
  ]

  return (
    <div
      ref={rootRef}
      className={`msftp-root ${selectionMode ? 'is-selecting' : ''}`}
      onPointerDown={() => { activeMobileSftpPane = pane }}
      onFocusCapture={() => { activeMobileSftpPane = pane }}
    >
      {selectionMode ? (
        <div className="msftp-header msftp-selection-header">
          <button className="msftp-icon-btn" type="button" aria-label="取消选择" onClick={() => { store.clearSelection(pane); setSelectionMode(false) }}><X /></button>
          <strong>已选择 {activeTab.selected.size} 项</strong>
          <button
            className="msftp-text-btn"
            type="button"
            onClick={() => activeTab.selected.size === activeTab.entries.length ? store.clearSelection(pane) : store.selectAll(pane)}
          >
            {activeTab.selected.size === activeTab.entries.length ? '取消全选' : '全选'}
          </button>
        </div>
      ) : (
        <div className="msftp-header">
          <button
            className="msftp-icon-btn"
            type="button"
            aria-label="返回上级目录"
            disabled={activeTab.path === '/'}
            onClick={() => void store.navigate(pane, parentPath(activeTab.path))}
          ><ArrowLeft /></button>
          <button className="msftp-server-title" type="button" onClick={() => setServersOpen(true)}>
            <strong>{activeTab.server.name}</strong>
            <span>{activeTab.loading ? '正在载入…' : `${activeTab.entries.length} 个项目`}</span>
          </button>
          <div className="msftp-header-actions">
            <button className="msftp-icon-btn" type="button" aria-label="连接服务器" onClick={() => setServersOpen(true)}><Plus /></button>
            <button className="msftp-icon-btn" type="button" aria-label="更多操作" onClick={() => setActionsOpen(true)}><MoreHorizontal /></button>
          </div>
        </div>
      )}

      <button className="msftp-path" type="button" onClick={() => setDirectoryAction('navigate')}>
        <FolderOpen size={15} />
        <span>{activeTab.path}</span>
        <ChevronRight size={15} />
      </button>

      <div className="msftp-list" role="listbox" aria-multiselectable={selectionMode}>
        {activeTab.loading ? (
          <div className="msftp-state"><Loader2 className="msftp-spin" /><span>正在载入目录…</span></div>
        ) : activeTab.error ? (
          <div className="msftp-state is-error">
            <AlertCircle />
            <strong>目录载入失败</strong>
            <span>{activeTab.error}</span>
            <Button variant="outline" onClick={() => void store.refresh(pane)}>重试</Button>
          </div>
        ) : activeTab.entries.length === 0 ? (
          <div className="msftp-state"><FolderOpen /><span>这个文件夹是空的</span></div>
        ) : (
          [...activeTab.entries]
            .sort((a, b) => a.is_dir === b.is_dir ? a.name.localeCompare(b.name, 'zh') : a.is_dir ? -1 : 1)
            .map((entry) => (
              <MobileFileRow
                key={entry.path}
                entry={entry}
                selected={activeTab.selected.has(entry.path)}
                selectionMode={selectionMode}
                onOpen={() => openEntry(entry)}
                onToggle={() => store.select(pane, entry.path, { additive: true })}
                onLongPress={() => enterSelection(entry)}
                onMore={() => setDetailEntry(entry)}
              />
            ))
        )}
      </div>

      {selectionMode && activeTab.selected.size > 0 ? (
        <div className="msftp-selection-bar">
          <SelectionButton icon={<Download />} label="下载" disabled={documentBusy} onClick={() => void download(selectedEntries)} />
          <SelectionButton icon={<Copy />} label="复制" onClick={() => setDirectoryAction('copy')} />
          <SelectionButton icon={<FolderInput />} label="移动" onClick={() => setDirectoryAction('move')} />
          <SelectionButton
            icon={<Pencil />}
            label="重命名"
            disabled={selectedEntries.length !== 1}
            onClick={() => selectedEntries[0] && store.openRenameDialog(pane, selectedEntries[0])}
          />
          <SelectionButton icon={<Trash2 />} label="删除" danger onClick={() => { store.openDeleteConfirm(pane, selectedEntries); setSelectionMode(false) }} />
        </div>
      ) : showTransferSummary ? (
        <MobileTransferSummary transfers={store.transfers} onOpen={() => setTransferOpen(true)} />
      ) : null}

      <MobileSheet open={actionsOpen} onOpenChange={setActionsOpen} title="文件操作" items={headerActions} />
      <ServerSheet open={serversOpen} onOpenChange={setServersOpen} pane={pane} onFallbackPicker={onPickServer} />
      <FileDetailSheet
        entry={detailEntry}
        open={detailEntry !== null}
        onOpenChange={(open) => !open && setDetailEntry(null)}
        onOpen={() => detailEntry && (detailEntry.is_dir ? openEntry(detailEntry) : void store.openEditor(pane, detailEntry.path))}
        onDownload={() => detailEntry && void download([detailEntry])}
        onSelect={() => detailEntry && enterSelection(detailEntry)}
      />
      <DirectoryPicker
        open={directoryAction !== null}
        action={directoryAction ?? 'navigate'}
        sourcePane={pane}
        sourceTab={activeTab}
        sourceEntries={selectedEntries}
        onOpenChange={(open) => !open && setDirectoryAction(null)}
        onConfirm={async (targetPane, targetTab, path) => {
          if (directoryAction === 'navigate') await store.navigate(pane, path)
          else if (directoryAction === 'move') await store.moveEntries(pane, selectedEntries.map((entry) => entry.path), path)
          else await store.transferEntries(pane, selectedEntries.map((entry) => entry.path), targetPane, targetTab.id, path)
          if (directoryAction !== 'navigate') {
            store.clearSelection(pane)
            setSelectionMode(false)
          }
          setDirectoryAction(null)
        }}
      />
      <MobileTransferDrawer open={transferOpen} onOpenChange={setTransferOpen} />
      <UploadConflictSheet
        pending={uploadPending}
        onCancel={() => void cancelUploadConflict()}
        onResolve={(resolution) => uploadPending && void uploadDocuments(uploadPending.documents, resolution)}
      />
    </div>
  )
}

function MobileFileRow({
  entry,
  selected,
  selectionMode,
  onOpen,
  onToggle,
  onLongPress,
  onMore,
}: {
  entry: SftpEntry
  selected: boolean
  selectionMode: boolean
  onOpen: () => void
  onToggle: () => void
  onLongPress: () => void
  onMore: () => void
}) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const suppressClick = useRef(false)
  const clear = () => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }
  useEffect(() => clear, [])
  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (selectionMode || event.pointerType === 'mouse') return
    suppressClick.current = false
    const x = event.clientX
    const y = event.clientY
    press.current = {
      x,
      y,
      timer: setTimeout(() => {
        suppressClick.current = true
        onLongPress()
        press.current = null
      }, MOBILE_SFTP_LONG_PRESS_MS),
    }
  }
  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!press.current) return
    if (!isWithinMobileLongPressSlop(press.current.x, press.current.y, event.clientX, event.clientY)) clear()
  }

  return (
    <div className={`msftp-row ${selected ? 'is-selected' : ''}`} role="option" aria-selected={selected}>
      <button
        type="button"
        className="msftp-row-main"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={clear}
        onPointerCancel={clear}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false
            return
          }
          if (selectionMode) onToggle()
          else onOpen()
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          if (suppressClick.current) return
          suppressClick.current = true
          onLongPress()
        }}
      >
        <span className="msftp-row-icon">{selected ? <Check size={18} /> : fileIcon(entry)}</span>
        <span className="msftp-row-copy">
          <strong>{entry.name}</strong>
          <small>{entry.is_dir ? '文件夹' : formatSize(entry.size)}{entry.mod_time ? ` · ${formatDate(entry.mod_time)}` : ''}</small>
        </span>
      </button>
      {!selectionMode && (
        <button type="button" className="msftp-row-more" aria-label={`${entry.name} 的更多操作`} onClick={onMore}>
          <MoreHorizontal size={18} />
        </button>
      )}
    </div>
  )
}

function SelectionButton({ icon, label, onClick, disabled, danger }: {
  icon: ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button type="button" className={danger ? 'is-danger' : ''} disabled={disabled} onClick={onClick}>
      {icon}<span>{label}</span>
    </button>
  )
}

function ServerSheet({ open, onOpenChange, pane, onFallbackPicker }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pane: PaneSide
  onFallbackPicker: () => void
}) {
  const store = useSftpStore()
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<Group[]>([])
  const tabs = pane === 'left' ? store.leftTabs : store.rightTabs
  const activeId = pane === 'left' ? store.activeLeftTabId : store.activeRightTabId

  useEffect(() => {
    if (!open) return
    void groupApi.list().then(setGroups).catch(() => setGroups([]))
  }, [open])

  const visibleServers = store.servers.filter((server) => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    return !needle || `${server.name} ${server.host} ${server.username}`.toLocaleLowerCase('zh-CN').includes(needle)
  })
  const knownGroupIds = new Set(groups.map((group) => group.id))
  const groupOrder = [...groups.map((group) => group.id), '']

  return (
    <MobileSheet open={open} onOpenChange={onOpenChange} title="服务器" className="msftp-server-sheet">
      <div className="msftp-sheet-search"><Search /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索服务器" /></div>
      <div className="msftp-server-list">
        {tabs.length > 0 && <div className="msftp-sheet-label">已连接</div>}
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={tab.id === activeId ? 'is-active' : ''}
            onClick={() => {
              store.setActiveTab(pane, tab.id)
              onOpenChange(false)
            }}
          >
            <Server /><span><strong>{tab.server.name}</strong><small>{tab.path}</small></span>
            {tab.id === activeId && <Check />}
          </button>
        ))}
        {groupOrder.map((groupId) => {
          const group = groups.find((candidate) => candidate.id === groupId)
          const servers = visibleServers.filter((server) => {
            const belongsToGroup = groupId
              ? server.groupId === groupId
              : !server.groupId || !knownGroupIds.has(server.groupId)
            return belongsToGroup && !tabs.some((tab) => tab.server.id === server.id)
          })
          if (servers.length === 0) return null
          return (
            <div key={groupId || 'ungrouped'}>
              <div className="msftp-sheet-label">{group?.name ?? (groups.length ? '未分组' : '可用服务器')}</div>
              {servers.map((server) => (
                <button key={server.id} type="button" onClick={() => {
                  onOpenChange(false)
                  void store.connectServer(pane, server)
                }}>
                  <Server /><span><strong>{server.name}</strong><small>{server.username}@{server.host}:{server.port}</small></span><ChevronRight />
                </button>
              ))}
            </div>
          )
        })}
        {store.serversLoading && <div className="msftp-sheet-empty"><Loader2 className="msftp-spin" /> 正在载入服务器…</div>}
        {!store.serversLoading && visibleServers.length === 0 && <div className="msftp-sheet-empty">没有匹配的服务器</div>}
      </div>
      <button type="button" className="msftp-sheet-fallback" onClick={() => { onOpenChange(false); onFallbackPicker() }}>打开完整服务器选择器</button>
    </MobileSheet>
  )
}

interface DirectoryTarget { pane: PaneSide; tab: SftpTab }

function DirectoryPicker({ open, action, sourcePane, sourceTab, sourceEntries, onOpenChange, onConfirm }: {
  open: boolean
  action: MobileDirectoryAction
  sourcePane: PaneSide
  sourceTab: SftpTab
  sourceEntries: SftpEntry[]
  onOpenChange: (open: boolean) => void
  onConfirm: (pane: PaneSide, tab: SftpTab, path: string) => Promise<void>
}) {
  const store = useSftpStore()
  const targets = useMemo<DirectoryTarget[]>(() => {
    const all = [
      ...store.leftTabs.map((tab) => ({ pane: 'left' as const, tab })),
      ...store.rightTabs.map((tab) => ({ pane: 'right' as const, tab })),
    ].filter((item) => item.tab.sessionId)
    if (action === 'move' || action === 'navigate') {
      return all.filter((item) => item.pane === sourcePane && item.tab.id === sourceTab.id)
    }
    return all
  }, [action, sourcePane, sourceTab.id, store.leftTabs, store.rightTabs])
  const [targetKey, setTargetKey] = useState('')
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const keyOf = (target: DirectoryTarget) => `${target.pane}:${target.tab.id}`
  const selectedTarget = targets.find((target) => keyOf(target) === targetKey) ?? targets[0]

  useEffect(() => {
    if (!open) return
    const preferred = targets.find((target) => target.tab.id === sourceTab.id) ?? targets[0]
    setTargetKey(preferred ? keyOf(preferred) : '')
    setPath(preferred?.tab.path ?? '/')
  }, [open, sourceTab.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !selectedTarget?.tab.sessionId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void sftpApi.list(selectedTarget.tab.sessionId, path, false).then((response) => {
      if (cancelled) return
      setPath(response.path)
      setEntries(response.entries.filter((entry) => entry.is_dir).sort((a, b) => a.name.localeCompare(b.name, 'zh')))
      setLoading(false)
    }).catch((reason) => {
      if (cancelled) return
      setError(reason instanceof Error ? reason.message : '目录载入失败')
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, path, reloadKey, selectedTarget?.tab.sessionId])

  const invalid = selectedTarget?.tab.sessionId
    ? mobileDestinationError(action, sourceTab.sessionId ?? '', selectedTarget.tab.sessionId, sourceEntries, path)
    : '没有可用的目标会话'

  return (
    <MobileSheet open={open} onOpenChange={onOpenChange} title={action === 'navigate' ? '前往目录' : action === 'move' ? '移动到' : '复制到'} className="msftp-directory-sheet">
      {targets.length > 1 && (
        <div className="msftp-target-tabs">
          {targets.map((target) => <button key={keyOf(target)} type="button" className={keyOf(target) === keyOf(selectedTarget) ? 'is-active' : ''} onClick={() => { setTargetKey(keyOf(target)); setPath(target.tab.path) }}>{target.tab.server.name}</button>)}
        </div>
      )}
      <div className="msftp-picker-path">
        <button type="button" disabled={path === '/'} onClick={() => setPath(parentPath(path))}><ArrowLeft /></button>
        <span>{path}</span>
      </div>
      <div className="msftp-directory-list">
        {loading ? <div className="msftp-sheet-empty"><Loader2 className="msftp-spin" /> 正在载入…</div>
          : error ? <div className="msftp-sheet-empty is-error"><AlertCircle />{error}<Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>重试</Button></div>
            : entries.length === 0 ? <div className="msftp-sheet-empty">没有子文件夹</div>
              : entries.map((entry) => <button key={entry.path} type="button" onClick={() => setPath(entry.path)}><Folder /><span>{entry.name}</span><ChevronRight /></button>)}
      </div>
      {invalid && <p className="msftp-picker-error">{invalid}</p>}
      <div className="msftp-sheet-footer">
        <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
        <Button disabled={Boolean(invalid) || loading || !selectedTarget} onClick={() => selectedTarget && void onConfirm(selectedTarget.pane, selectedTarget.tab, path)}>
          {action === 'navigate' ? '打开此目录' : '选择此目录'}
        </Button>
      </div>
    </MobileSheet>
  )
}

function FileDetailSheet({ entry, open, onOpenChange, onOpen, onDownload, onSelect }: {
  entry: SftpEntry | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpen: () => void
  onDownload: () => void
  onSelect: () => void
}) {
  if (!entry) return null
  const items: MobileSheetItem[] = [
    ...(entry.is_dir || isEditableMobileSftpEntry(entry) ? [{ id: 'open', label: entry.is_dir ? '打开文件夹' : '编辑文本', icon: entry.is_dir ? FolderOpen : Pencil, onSelect: onOpen }] : []),
    ...(!entry.is_dir ? [{ id: 'download', label: '下载到系统文件', icon: Download, onSelect: onDownload }] : []),
    { id: 'copy-path', label: '复制路径', icon: Copy, onSelect: () => void writeClipboardText(entry.path) },
    { id: 'select', label: '选择项目', icon: CheckCircle2, onSelect },
  ]
  return (
    <MobileSheet open={open} onOpenChange={onOpenChange} title={entry.name} items={items} className="msftp-detail-sheet">
      <div className="msftp-file-meta">
        <span>{entry.is_dir ? '文件夹' : formatSize(entry.size)}</span>
        {entry.mod_time && <span>修改于 {formatDate(entry.mod_time)}</span>}
        {entry.mode && <span>权限 {entry.mode}</span>}
        <code>{entry.path}</code>
      </div>
    </MobileSheet>
  )
}

function mergeTransfers(current: TransferTask[], incoming: TransferTask[]) {
  const map = new Map(current.map((task) => [task.id, task]))
  incoming.forEach((task) => map.set(task.id, task))
  return [...map.values()]
}

function MobileTransferSummary({ transfers, onOpen }: { transfers: TransferTask[]; onOpen: () => void }) {
  if (transfers.length === 0) return null
  const { active, failed, progress } = summarizeMobileTransfers(transfers)
  return (
    <button className="msftp-transfer-summary" type="button" onClick={onOpen}>
      <span className="msftp-transfer-summary-icon">{active.length ? <Loader2 className="msftp-spin" /> : failed.length ? <AlertCircle /> : <CheckCircle2 />}</span>
      <span><strong>{active.length ? `${active.length} 个任务进行中` : failed.length ? `${failed.length} 个任务失败` : '传输已完成'}</strong><small>{active.length ? `${Math.round(progress * 100)}%` : '查看传输记录'}</small></span>
      <ChevronRight />
    </button>
  )
}

function MobileTransferDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { transfers, cancelTransfer, clearCompleted } = useSftpStore()
  return (
    <MobileSheet open={open} onOpenChange={onOpenChange} title="传输任务" className="msftp-transfer-sheet">
      <div className="msftp-transfer-list">
        {transfers.map((task) => {
          const active = task.status === 'queued' || task.status === 'transferring'
          const pct = task.size ? Math.min(100, Math.round(task.transferred / task.size * 100)) : 0
          return (
            <div key={task.id} className={`msftp-transfer-item is-${task.status}`}>
              <span className="msftp-transfer-dir">{task.direction === 'upload' ? <ArrowUp /> : task.direction === 'download' ? <ArrowDown /> : <Copy />}</span>
              <span className="msftp-transfer-copy"><strong>{task.file_name}</strong><small>{active ? `${formatSize(task.transferred)} / ${formatSize(task.size)} · ${formatSize(task.speed)}/s` : task.error_message || transferLabel(task)}</small><span><i style={{ width: `${pct}%` }} /></span></span>
              {active && <button type="button" aria-label={`取消 ${task.file_name}`} onClick={() => void cancelTransfer(task.id)}><X /></button>}
            </div>
          )
        })}
        {transfers.length === 0 && <div className="msftp-sheet-empty">暂无传输任务</div>}
      </div>
      {transfers.some((task) => !['queued', 'transferring'].includes(task.status)) && <button className="msftp-sheet-fallback" type="button" onClick={() => void clearCompleted()}>清理已完成和失败记录</button>}
    </MobileSheet>
  )
}

function transferLabel(task: TransferTask) {
  if (task.status === 'completed') return '已完成'
  if (task.status === 'cancelled') return '已取消'
  if (task.status === 'failed') return '传输失败'
  return '等待中'
}

function UploadConflictSheet({ pending, onCancel, onResolve }: {
  pending: { documents: DocumentDescriptor[]; conflicts: number } | null
  onCancel: () => void
  onResolve: (resolution: Exclude<ConflictResolution, 'ask'>) => void
}) {
  return (
    <MobileSheet open={pending !== null} onOpenChange={(open) => !open && onCancel()} title="同名文件" className="msftp-conflict-sheet">
      <div className="msftp-conflict-copy">
        <AlertCircle />
        <p>目标目录中已有 {pending?.conflicts ?? 0} 个同名文件，请为本批上传选择处理方式。</p>
      </div>
      <div className="msftp-conflict-actions">
        <button type="button" onClick={() => onResolve('overwrite')}><strong>覆盖</strong><span>替换已有文件</span></button>
        <button type="button" onClick={() => onResolve('rename')}><strong>自动重命名</strong><span>保留两份文件</span></button>
        <button type="button" onClick={() => onResolve('skip')}><strong>跳过</strong><span>不上传同名文件</span></button>
      </div>
    </MobileSheet>
  )
}
