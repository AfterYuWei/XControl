import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { FolderUp, X } from 'lucide-react'
import { Dialog } from '@/components/ui/dialog'
import { useSessionStore } from '@/store/session'
import { useSftpStore } from './storeContext'
import { type PaneSide } from '@/store/sftp'
import { resolveServerIcon } from '@/lib/serverIcons'
import { resolveGroupIcon } from '@/lib/groupIcons'
import { groupApi } from '@/api/group'
import type { Group } from '@/types/group'
import type { SftpServer } from '@/types/sftp'

interface ServerPickerProps {
  open: boolean
  pane: PaneSide | null
  onClose: () => void
}

/** Server selection dialog. Servers are grouped by their group (like the
 *  sidebar), with ungrouped servers rendered last. The currently active
 *  terminal tab's server is highlighted with an accent border. Picking a
 *  server connects it as a new tab in the target pane. */
export function ServerPicker({ open, pane, onClose }: ServerPickerProps) {
  const { tabs, activeTabId } = useSessionStore()
  const servers = useSftpStore((s) => s.servers)
  const connectServer = useSftpStore((s) => s.connectServer)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [groups, setGroups] = useState<Group[]>([])

  // Load groups when the dialog opens (mirrors the sidebar's classification)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    groupApi.list().then((list) => {
      if (!cancelled) setGroups(list)
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open])

  // Resolve the active terminal tab's host as the "recommended" server.
  const activeTab = tabs.find((t) => t.id === activeTabId && t.kind === 'terminal')
  const recommendedId = activeTab?.host ? `${activeTab.host}:${activeTab.port ?? 22}` : null

  // Group servers like the sidebar: grouped servers under their group,
  // loose (no group / stale group id) servers rendered last.
  const { grouped, loose } = useMemo(() => {
    const map = new Map<string, SftpServer[]>()
    groups.forEach((g) => map.set(g.id, []))
    const looseList: SftpServer[] = []
    servers.forEach((s) => {
      if (s.groupId && map.has(s.groupId)) map.get(s.groupId)!.push(s)
      else looseList.push(s)
    })
    return { grouped: groups.map((g) => ({ group: g, list: map.get(g.id)! })), loose: looseList }
  }, [servers, groups])

  const handleConnect = (server: SftpServer) => {
    if (pane) connectServer(pane, server)
    setSelectedId(null)
    onClose()
  }

  // Reset selection when dialog closes
  const handleOpenChange = (o: boolean) => {
    if (!o) setSelectedId(null)
    if (!o) onClose()
  }

  const renderServerCard = (s: SftpServer) => {
    const isRecommended = `${s.host}:${s.port}` === recommendedId
    const isSelected = s.id === selectedId
    const Icon = resolveServerIcon(s.icon)
    return (
      <div
        key={s.id}
        role="option"
        aria-selected={isSelected}
        tabIndex={0}
        className={`sftp-server-card ${isRecommended ? 'recommended' : ''} ${isSelected ? 'selected' : ''}`}
        onClick={() => setSelectedId(s.id)}
        onDoubleClick={() => handleConnect(s)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleConnect(s)
          }
        }}
      >
        <span className="sftp-server-icon">
          <Icon size={16} />
        </span>
        <span className="sftp-server-info">
          <span className="sftp-server-name">
            {s.name}
            {isRecommended && <span className="sftp-server-tag">当前会话</span>}
          </span>
          <span className="sftp-server-meta">
            {s.username}@{s.host}:{s.port}
          </span>
        </span>
        <FolderUp size={14} className="sftp-server-arrow" />
      </div>
    )
  }

  const renderGroupHeader = (icon: ReactNode, name: string, count: number, muted = false) => (
    <div className={`sftp-picker-grp ${muted ? 'muted' : ''}`}>
      {icon}
      <span className="sftp-picker-grp-text">{name}</span>
      <span className="sftp-picker-grp-cnt">{count}</span>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <div className="sftp-picker">
        <div className="sftp-picker-hdr">
          <span className="sftp-picker-title">选择服务器</span>
          <button className="sftp-picker-x" onClick={onClose} aria-label="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="sftp-picker-sub">
          单击选中服务器，双击进行连接。当前终端会话的服务器已高亮。
        </div>
        <div className="sftp-picker-list">
          {grouped.map(({ group, list }) => {
            if (list.length === 0) return null
            const GIcon = resolveGroupIcon(group.icon)
            return (
              <div key={group.id} className="sftp-picker-group">
                {renderGroupHeader(
                  <GIcon size={12} className="sftp-picker-grp-icon" />,
                  group.name,
                  list.length
                )}
                {list.map(renderServerCard)}
              </div>
            )
          })}
          {loose.length > 0 && (
            <div className="sftp-picker-group">
              {groups.length > 0 &&
                renderGroupHeader(null, '未分组', loose.length, true)}
              {loose.map(renderServerCard)}
            </div>
          )}
          {servers.length === 0 && (
            <div className="sftp-picker-empty">暂无可用服务器</div>
          )}
        </div>
      </div>
    </Dialog>
  )
}
