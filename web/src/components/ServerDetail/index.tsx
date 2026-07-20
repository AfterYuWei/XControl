import React, { useEffect, useRef, useState } from 'react'
import {
  File, Folder, HardDrive, Cpu, Loader2, AlertCircle,
  FilePlus, FolderPlus, RefreshCw, Pencil, Trash2, Copy, Eye, EyeOff,
  FolderOpen, FileEdit, Inbox, Crosshair
} from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useSidebarDetailStore } from '@/store/sidebarDetail'
import { useServerDetailStore } from '@/store/serverDetail'
import { Tooltip } from '@/components/ui/tooltip'
import { useServerMetrics } from '@/hooks/useServerMetrics'
import { EditorDialog } from '@/components/Editor/EditorDialog'
import { SftpContextMenu, type MenuItem } from '@/components/Sftp/SftpContextMenu'
import { InputDialog, validateSftpName } from '@/components/Sftp/InputDialog'
import { DeleteConfirmDialog } from '@/components/Sftp/DeleteConfirmDialog'
import type { FileTreeNode } from '@/store/serverDetail'
import type { SftpEntry } from '@/types/sftp'

interface ServerDetailProps {
  tabId: string
  profileId: string
  profileName: string
  host: string
  port: number
  username: string
  /** When false the pane is hidden (display:none) but stays mounted. */
  active: boolean
}

export function ServerDetail({
  tabId,
  profileId,
  profileName,
  host,
  port,
  username,
  active,
}: ServerDetailProps) {
  const { tabs } = useSessionStore()
  const { getDetail, saveDetail, toggleFiles, toggleMetrics, toggleInfo, toggleFollowShellCwd } = useSidebarDetailStore()
  const {
    getStatus, navigateToParent, listFiles, mkdir, createFile, rename, deleteSelected,
    toggleShowHidden, refresh, select, clearSelection, getSelectedNodes
  } = useServerDetailStore()
  const tab = tabs.find((t) => t.id === tabId)
  const isOff = tab?.status === 'disconnected'
  const serverDetail = getStatus(profileId)
  const bodyRef = useRef<HTMLDivElement>(null)
  const detail = getDetail(tabId)

  // Context menu state
  const [ctx, setCtx] = useState<{ x: number; y: number; entry: FileTreeNode | null } | null>(null)
  // Dialog states
  const [newFileDialog, setNewFileDialog] = useState(false)
  const [newFolderDialog, setNewFolderDialog] = useState(false)
  const [renameDialog, setRenameDialog] = useState<{ path: string; currentName: string } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ entries: FileTreeNode[] } | null>(null)

  // Connect WebSocket for real-time metrics
  useServerMetrics(profileId, active)

  // Restore scroll position on mount / when becoming visible again.
  useEffect(() => {
    const el = bodyRef.current
    if (el && active) {
      el.scrollTop = detail.scrollTop
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const cwd = tab?.cwd

  // Auto-navigate the file browser when the shell CWD changes and follow is on.
  useEffect(() => {
    if (!cwd || !detail.followShellCwd) return
    const connected = serverDetail.status === 'connected'
    if (!connected) return
    const currentPath = serverDetail.currentPath || '/'
    if (cwd !== currentPath) {
      listFiles(profileId, cwd)
    }
  }, [cwd, detail.followShellCwd])

  // Manual navigation: any directory change initiated inside the file browser
  // (double-click folder, "..", breadcrumb, context menu) turns off the
  // follow-shell-CWD toggle first, so the browser stays where the user put it
  // instead of being yanked back on the next shell cd.
  const navigateManually = (path: string) => {
    if (detail.followShellCwd) {
      saveDetail(tabId, { followShellCwd: false })
    }
    listFiles(profileId, path)
  }
  const navigateToParentManually = () => {
    if (detail.followShellCwd) {
      saveDetail(tabId, { followShellCwd: false })
    }
    navigateToParent(profileId)
  }

  const handleScroll = () => {
    const el = bodyRef.current
    if (el) {
      // saveDetail is not available from the store directly; skip for now
    }
  }

  const metrics = serverDetail.metrics
  const info = serverDetail.info

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
  }

  const formatBytesPerSec = (bytesPerSec: number): string => {
    if (bytesPerSec === 0) return '0 B/s'
    if (bytesPerSec < 1024) return `${bytesPerSec} B/s`
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
  }

  /** Compact uptime: "up 5 days, 2 hours, 39 minutes" → "5d 2h 39m" */
  const compactUptime = (raw: string): string => {
    if (!raw) return '—'
    // Handle "up X days, Y hours, Z minutes" format from `uptime -p`
    const dayMatch = raw.match(/(\d+)\s*day/)
    const hourMatch = raw.match(/(\d+)\s*hour/)
    const minMatch = raw.match(/(\d+)\s*min/)
    const parts: string[] = []
    if (dayMatch) parts.push(`${dayMatch[1]}d`)
    if (hourMatch) parts.push(`${hourMatch[1]}h`)
    if (minMatch) parts.push(`${minMatch[1]}m`)
    return parts.length > 0 ? parts.join(' ') : raw
  }

  /** Parse load_avg_detail: "0.00 0.01 0.00 1/354 308603" → "1/354, 线程308603" */
  const parseLoadDetail = (detail: string): string => {
    if (!detail) return ''
    const parts = detail.split(/\s+/)
    if (parts.length >= 5) {
      return `${parts[3]}, 线程${parts[4]}`
    }
    return ''
  }

  const statusText = isOff ? '未连接' : tab?.status === 'connecting' ? '连接中' : '已连接'
  const connectionDisplay = `${host}:${port}`
  const platformDisplay = info.os || info.kernel || '—'
  const runtimeDisplay = info.uptime ? `${statusText} ${compactUptime(info.uptime)}` : statusText
  const loadDisplay = info.load_avg || '—'

  const renderInfoTooltip = (rows: Array<{ label: string; value: string }>) => (
    <div className="sdetail-tip">
      {rows.filter((row) => row.value).map((row) => (
        <div key={row.label} className="sdetail-tip-row">
          <span className="sdetail-tip-label">{row.label}</span>
          <span className="sdetail-tip-val">{row.value}</span>
        </div>
      ))}
    </div>
  )

  // Convert FileTreeNode to SftpEntry for dialogs
  const toSftpEntry = (node: FileTreeNode): SftpEntry => ({
    name: node.name,
    path: node.path,
    is_dir: node.isDir,
    size: node.size,
    mod_time: node.modTime,
    mode: node.mode,
  })

  // Get current path for new file/folder creation
  // If a directory is selected, use that path; otherwise use currentPath
  const getCurrentPath = (): string => {
    const selectedNodes = getSelectedNodes(profileId)
    if (selectedNodes.length === 1) {
      const node = selectedNodes[0]
      return node.isDir ? node.path : (node.path.substring(0, node.path.lastIndexOf('/')) || '/')
    }
    return serverDetail.currentPath || serverDetail.homeDir || '/'
  }

  // Context menu items for file/folder
  const fileMenuItems = (node: FileTreeNode): MenuItem[] => [
    { id: 'open', label: node.isDir ? '打开文件夹' : '打开', icon: <FolderOpen size={13} />, onClick: () => {
      if (node.isDir) navigateManually(node.path)
      else useServerDetailStore.getState().openEditor(profileId, node.path)
    }},
    ...(!node.isDir ? [{
      id: 'edit',
      label: '编辑',
      icon: <FileEdit size={13} />,
      onClick: () => useServerDetailStore.getState().openEditor(profileId, node.path),
    }] : []),
    { id: 'd1', label: '', divider: true },
    { id: 'newFile', label: '新建文件', icon: <FilePlus size={13} />, onClick: () => setNewFileDialog(true) },
    { id: 'newFolder', label: '新建文件夹', icon: <FolderPlus size={13} />, onClick: () => setNewFolderDialog(true) },
    { id: 'd2', label: '', divider: true },
    { id: 'rename', label: '重命名', icon: <Pencil size={13} />, onClick: () => setRenameDialog({ path: node.path, currentName: node.name }) },
    { id: 'copy', label: '复制路径', icon: <Copy size={13} />, onClick: () => navigator.clipboard?.writeText(node.path) },
    { id: 'd3', label: '', divider: true },
    { id: 'del', label: '删除', icon: <Trash2 size={13} />, danger: true, onClick: () => setDeleteConfirm({ entries: [node] }) },
  ]

  // Context menu items for blank area
  const blankMenuItems = (): MenuItem[] => [
    { id: 'newFile', label: '新建文件', icon: <FilePlus size={13} />, onClick: () => setNewFileDialog(true) },
    { id: 'newFolder', label: '新建文件夹', icon: <FolderPlus size={13} />, onClick: () => setNewFolderDialog(true) },
    { id: 'd1', label: '', divider: true },
    { id: 'refresh', label: '刷新', icon: <RefreshCw size={13} />, onClick: () => refresh(profileId) },
  ]

  // Dialog handlers
  const handleCreateFile = async (name: string) => {
    const currentPath = getCurrentPath()
    const filePath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`
    await createFile(profileId, filePath)
  }

  const handleCreateFolder = async (name: string) => {
    const currentPath = getCurrentPath()
    const folderPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`
    await mkdir(profileId, folderPath)
  }

  const handleRename = async (newName: string) => {
    if (!renameDialog) return
    const parentPath = renameDialog.path.substring(0, renameDialog.path.lastIndexOf('/')) || '/'
    const newPath = parentPath === '/' ? `/${newName}` : `${parentPath}/${newName}`
    await rename(profileId, renameDialog.path, newPath)
  }

  const handleDelete = async () => {
    if (!deleteConfirm) return
    const paths = deleteConfirm.entries.map((e) => e.path)
    await deleteSelected(profileId, paths)
  }

  const renderFileRow = (node: FileTreeNode) => {
    const isSelected = serverDetail.selected.has(node.path)

    // Single click: select only
    const handleClick = (e: React.MouseEvent) => {
      e.stopPropagation()
      select(profileId, node.path, { additive: e.metaKey || e.ctrlKey })
    }

    // Double click: open file or navigate into directory
    const handleDoubleClick = (e: React.MouseEvent) => {
      e.stopPropagation()
      if (node.isDir) {
        // Navigate into directory
        navigateManually(node.path)
      } else {
        // Open file in editor
        const detail = useServerDetailStore.getState().getStatus(profileId)
        if (detail.sessionId) {
          useServerDetailStore.getState().openEditor(profileId, node.path)
        }
      }
    }

    return (
      <div
        key={node.path}
        className={`sdetail-file-row ${isSelected ? 'selected' : ''}`}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          // Don't select on right-click, only show context menu
          setCtx({ x: e.clientX, y: e.clientY, entry: node })
        }}
        role="button"
      >
        <div className="sdetail-file-left">
          {node.isDir ? (
            <Folder size={13} className="sdetail-file-icon dir" />
          ) : (
            <File size={13} className="sdetail-file-icon file" />
          )}
          <span className="sdetail-file-name">{node.name}</span>
        </div>
        <div className="sdetail-file-right">
          <span className="sdetail-file-size">
            {node.isDir ? '' : formatBytes(node.size)}
          </span>
        </div>
      </div>
    )
  }

  // Loading state for the whole component
  const isConnecting = serverDetail.status === 'connecting'
  const isConnected = serverDetail.status === 'connected'
  const hasError = serverDetail.status === 'disconnected' && serverDetail.error

  return (
    <div className="flex flex-col h-full sdetail-pane" aria-hidden={!active}>
      {/* Header — server identity */}
      <div className="sdetail-hdr">
        <div className="sdetail-hdr-info">
          <span className="sdetail-hdr-name">{profileName}</span>
          <span className="sdetail-hdr-meta">
            {username}@{host}{port !== 22 ? `:${port}` : ''}
          </span>
        </div>
      </div>

      {/* File browser header — outside the scroll area */}
      <div className="sdetail-file-hdr">
        <button
          className="psec-title sdetail-collapse-hdr sdetail-file-toggle"
          onClick={() => toggleFiles(tabId)}
          aria-label={detail.filesCollapsed ? '展开文件管理' : '折叠文件管理'}
          aria-expanded={!detail.filesCollapsed}
        >
          <Folder size={11} className="psec-title-icon" />
          <span className="psec-title-text">文件管理</span>
        </button>
        {!detail.filesCollapsed && isConnected && (
          <div className="sdetail-file-actions">
            {/* Follow shell CWD toggle */}
            {tab?.cwd && (
              <button
                className={`sdetail-act-btn${detail.followShellCwd ? ' sdetail-act-btn-active' : ''}`}
                title={detail.followShellCwd ? '自动跟随已开启：点击关闭' : '自动跟随已关闭：点击开启'}
                onClick={() => toggleFollowShellCwd(tabId)}
              >
                <Crosshair size={12} />
              </button>
            )}
            {serverDetail.selected.size > 0 && (
              <button
                className="sdetail-act-btn sdetail-act-btn-danger"
                title="删除选中"
                onClick={() => {
                  const selectedNodes = getSelectedNodes(profileId)
                  if (selectedNodes.length > 0) {
                    setDeleteConfirm({ entries: selectedNodes })
                  }
                }}
              >
                <Trash2 size={12} />
              </button>
            )}
            <button
              className="sdetail-act-btn"
              title="刷新"
              onClick={() => refresh(profileId)}
            >
              <RefreshCw size={12} />
            </button>
            <button
              className="sdetail-act-btn"
              title={serverDetail.showHidden ? '隐藏隐藏文件' : '显示隐藏文件'}
              onClick={() => toggleShowHidden(profileId)}
            >
              {serverDetail.showHidden ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          </div>
        )}
      </div>

      {/* Current path display - clickable to edit */}
      {!detail.filesCollapsed && isConnected && (
        <PathBreadcrumb
          path={serverDetail.currentPath || '/'}
          onNavigate={navigateManually}
        />
      )}

      {/* File browser list — fills remaining space, scrolls independently */}
      {!detail.filesCollapsed && (
        <div
          className="sdetail-file-area"
          ref={bodyRef}
          onScroll={handleScroll}
          onClick={(e) => {
            // Clear selection when clicking on empty area
            if (e.target === e.currentTarget || (e.target as HTMLElement).closest('.sdetail-file-empty')) {
              clearSelection(profileId)
            }
          }}
          onContextMenu={(e) => {
            if (e.target === e.currentTarget || (e.target as HTMLElement).closest('.sdetail-file-empty')) {
              e.preventDefault()
              setCtx({ x: e.clientX, y: e.clientY, entry: null })
            }
          }}
        >
          <div className="sdetail-file-list">
            {isConnecting && (
              <div className="sdetail-file-loading">
                <Loader2 size={14} className="animate-spin" />
                <span>正在连接服务器...</span>
              </div>
            )}
            {hasError && (
              <div className="sdetail-file-error">
                <AlertCircle size={14} />
                <span>{serverDetail.error}</span>
              </div>
            )}
            {isConnected && (
              <>
                {/* Parent directory entry ".." */}
                {serverDetail.currentPath !== '/' && serverDetail.currentPath !== '' && (
                  <div
                    className="sdetail-file-row"
                    style={{ cursor: 'pointer' }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      navigateToParentManually()
                    }}
                    role="button"
                  >
                    <div className="sdetail-file-left">
                      <Folder size={13} className="sdetail-file-icon dir" />
                      <span className="sdetail-file-name">..</span>
                    </div>
                    <div className="sdetail-file-right">
                      <span className="sdetail-file-size" />
                    </div>
                  </div>
                )}
                {serverDetail.loading && (
                  <div className="sdetail-file-loading">
                    <Loader2 size={14} className="animate-spin" />
                    <span>加载中...</span>
                  </div>
                )}
                {!serverDetail.loading && serverDetail.files.length === 0 && (
                  <div className="sdetail-file-empty sdetail-file-loading">
                    <Inbox size={14} />
                    <span>空文件夹</span>
                  </div>
                )}
                {!serverDetail.loading && serverDetail.files.map((f) => renderFileRow(f))}
              </>
            )}
          </div>
        </div>
      )}

      {/* Bottom panels — pinned at the bottom, collapsible */}
      <div className="sdetail-bottom">
        {/* System Metrics */}
        <div className="psec sdetail-bottom-sec">
          <button
            className="psec-title sdetail-collapse-hdr"
            onClick={() => toggleMetrics(tabId)}
            aria-label={detail.metricsCollapsed ? '展开系统指标' : '折叠系统指标'}
            aria-expanded={!detail.metricsCollapsed}
          >
            <Cpu size={11} className="psec-title-icon" />
            <span className="psec-title-text">系统指标</span>
          </button>
          {!detail.metricsCollapsed && (
            <div className="psec-body">
              <Tooltip
                side="top"
                content={metrics?.cpu_detail?.length ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '2px 12px' }}>
                    {metrics.cpu_detail.map((v, i) => (
                      <React.Fragment key={i}>
                        <span className="opacity-70">Core {i}</span>
                        <span className="font-mono text-right">{v.toFixed(1)}%</span>
                      </React.Fragment>
                    ))}
                  </div>
                ) : null}
              >
                <div className="metric" style={{ opacity: isOff || !metrics ? 0.4 : 1 }}>
                  <div className="m-head">
                    <span className="m-label">CPU</span>
                    <span className="m-val">{`${metrics.cpu.toFixed(1)}%`}</span>
                  </div>
                  <div className="m-bar">
                    <div className="m-fill cpu" style={{ width: `${metrics.cpu}%` }} />
                  </div>
                  <div className="m-sub">
                    {(() => {
                      const mhz = metrics.cpu_mhz || info.cpu_mhz
                      return <span>{mhz ? `${(mhz / 1000).toFixed(2)} GHz` : '—'}</span>
                    })()}
                  </div>
                </div>
              </Tooltip>
              <Tooltip
                side="top"
                content={metrics.mem_detail?.length ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '100px auto auto', gap: '2px 10px' }}>
                    {metrics.mem_detail.map((p, i) => (
                      <React.Fragment key={i}>
                        <span className="opacity-70 truncate">{p.name}</span>
                        <span className="font-mono text-right">{p.percent.toFixed(1)}%</span>
                        <span className="font-mono text-right opacity-70">{formatBytes(p.rss)}</span>
                      </React.Fragment>
                    ))}
                  </div>
                ) : null}
              >
                <div className="metric" style={{ opacity: isOff || !metrics ? 0.4 : 1 }}>
                  <div className="m-head">
                    <span className="m-label">内存</span>
                    <span className="m-val">{`${metrics.mem_percent.toFixed(1)}%`}</span>
                  </div>
                  <div className="m-bar">
                    <div className="m-fill mem" style={{ width: `${metrics.mem_percent}%` }} />
                  </div>
                  <div className="m-sub">
                    <span>{`${formatBytes(metrics.mem_used)} / ${formatBytes(metrics.mem_total)}`}</span>
                  </div>
                </div>
              </Tooltip>
              <div className="metric" style={{ opacity: isOff || !metrics ? 0.4 : 1 }}>
                <div className="m-head">
                  <span className="m-label">磁盘</span>
                  <span className="m-val">{`${metrics.disk_percent.toFixed(1)}%`}</span>
                </div>
                <div className="m-bar">
                  <div className="m-fill disk" style={{ width: `${metrics.disk_percent}%` }} />
                </div>
                <div className="m-sub">
                  <span>{`${formatBytes(metrics.disk_used)} / ${formatBytes(metrics.disk_total)}`}</span>
                </div>
              </div>
              <Tooltip
                side="top"
                content={metrics.net_detail?.length ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '80px auto auto', gap: '1px 8px', fontSize: '10px' }}>
                    {metrics.net_detail.map((n, i) => (
                      <React.Fragment key={i}>
                        <span className="opacity-70 truncate">{n.name}</span>
                        <span className="font-mono text-right">↓{formatBytesPerSec(n.rx)}</span>
                        <span className="font-mono text-right">↑{formatBytesPerSec(n.tx)}</span>
                      </React.Fragment>
                    ))}
                  </div>
                ) : null}
              >
                <div className="metric metric-compact" style={{ opacity: isOff || !metrics ? 0.4 : 1 }}>
                  <div className="m-head">
                    <span className="m-label">网络</span>
                    <span className="m-val" style={{ whiteSpace: 'nowrap' }}>
                      {`↓${formatBytesPerSec(metrics.net_rx)} ↑${formatBytesPerSec(metrics.net_tx)}`}
                    </span>
                  </div>
                </div>
              </Tooltip>
            </div>
          )}
        </div>

        {/* Server Info */}
        <div className="psec sdetail-bottom-sec">
          <button
            className="psec-title sdetail-collapse-hdr"
            onClick={() => toggleInfo(tabId)}
            aria-label={detail.infoCollapsed ? '展开服务器信息' : '折叠服务器信息'}
            aria-expanded={!detail.infoCollapsed}
          >
            <HardDrive size={11} className="psec-title-icon" />
            <span className="psec-title-text">服务器信息</span>
          </button>
          {!detail.infoCollapsed && (
            <div className="psec-body">
              <div className="info-row">
                <span className="info-label">主机名</span>
                <span className="info-val">{info.hostname || profileName}</span>
              </div>
              <div className="info-row">
                <span className="info-label">连接</span>
                <Tooltip
                  triggerClassName="flex-1 min-w-0"
                  content={renderInfoTooltip([
                    { label: '用户', value: username },
                    { label: '主机', value: host },
                    { label: '端口', value: String(port) },
                    { label: '地址', value: `${username}@${host}:${port}` },
                  ])}
                >
                  <span className="info-val">{connectionDisplay}</span>
                </Tooltip>
              </div>
              <div className="info-row">
                <span className="info-label">平台</span>
                <Tooltip
                  triggerClassName="flex-1 min-w-0"
                  content={renderInfoTooltip([
                    { label: '系统', value: info.os || '—' },
                    { label: '内核', value: info.kernel || '—' },
                    { label: '架构', value: info.arch || '—' },
                  ])}
                >
                  <span className="info-val">{platformDisplay}</span>
                </Tooltip>
              </div>
              <div className="info-row">
                <span className="info-label">状态</span>
                <Tooltip
                  triggerClassName="flex-1 min-w-0"
                  content={renderInfoTooltip([
                    { label: '连接', value: statusText },
                    { label: '运行', value: info.uptime || '—' },
                  ])}
                >
                  <span className="info-val">{runtimeDisplay}</span>
                </Tooltip>
              </div>
              <div className="info-row">
                <span className="info-label">负载</span>
                <Tooltip
                  triggerClassName="flex-1 min-w-0"
                  content={renderInfoTooltip([
                    { label: '平均', value: info.load_avg || '—' },
                    { label: '细节', value: parseLoadDetail(info.load_avg_detail || '') || '—' },
                    { label: '核心', value: info.cpus ? `${info.cpus} 核` : '—' },
                  ])}
                >
                  <span className="info-val">{loadDisplay}</span>
                </Tooltip>
              </div>
            </div>
          )}
        </div>
      </div>

      <EditorDialog />

      {/* Context Menu */}
      {ctx && (
        <SftpContextMenu
          x={ctx.x}
          y={ctx.y}
          items={ctx.entry ? fileMenuItems(ctx.entry) : blankMenuItems()}
          onClose={() => setCtx(null)}
        />
      )}

      {/* Dialogs */}
      <InputDialog
        open={newFileDialog}
        onOpenChange={setNewFileDialog}
        title="新建文件"
        label="文件名"
        placeholder="请输入文件名"
        confirmText="创建"
        onSubmit={handleCreateFile}
        validate={validateSftpName}
      />

      <InputDialog
        open={newFolderDialog}
        onOpenChange={setNewFolderDialog}
        title="新建文件夹"
        label="文件夹名称"
        placeholder="请输入文件夹名称"
        confirmText="创建"
        onSubmit={handleCreateFolder}
        validate={validateSftpName}
      />

      <InputDialog
        open={renameDialog !== null}
        onOpenChange={(open) => !open && setRenameDialog(null)}
        title="重命名"
        label="新名称"
        placeholder="请输入新名称"
        defaultValue={renameDialog?.currentName || ''}
        confirmText="确认"
        onSubmit={handleRename}
        validate={(name) => {
          const baseError = validateSftpName(name)
          if (baseError) return baseError
          if (renameDialog && name === renameDialog.currentName) return '新名称不能与原名称相同'
          return null
        }}
      />

      <DeleteConfirmDialog
        open={deleteConfirm !== null}
        onOpenChange={(open) => !open && setDeleteConfirm(null)}
        entries={deleteConfirm?.entries.map(toSftpEntry) || []}
        onConfirm={handleDelete}
      />
    </div>
  )
}

/** Path breadcrumb component - supports selection, copy, and manual input navigation */
function PathBreadcrumb({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(path)
  const inputRef = useRef<HTMLInputElement>(null)

  // Enter edit mode
  const handleDoubleClick = () => {
    setEditValue(path)
    setIsEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  // Submit navigation
  const handleSubmit = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== path) {
      onNavigate(trimmed)
    }
    setIsEditing(false)
  }

  // Handle keyboard events
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit()
    } else if (e.key === 'Escape') {
      setIsEditing(false)
    }
  }

  if (isEditing) {
    return (
      <div className="sdetail-file-path editing">
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSubmit}
          onKeyDown={handleKeyDown}
          className="sdetail-path-input"
          spellCheck={false}
        />
      </div>
    )
  }

  return (
    <div
      className="sdetail-file-path"
      title={`${path}\n双击编辑路径`}
      onDoubleClick={handleDoubleClick}
    >
      {path}
    </div>
  )
}
