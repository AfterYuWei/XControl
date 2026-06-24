import { useState } from 'react'
import { FolderUp, Server as ServerIcon, X } from 'lucide-react'
import { Dialog } from '@/components/ui/dialog'
import { useSessionStore } from '@/store/session'
import { useSftpStore } from './storeContext'
import { type PaneSide } from '@/store/sftp'
import { resolveServerIcon } from '@/lib/serverIcons'
import type { SftpServer } from '@/types/sftp'

interface ServerPickerProps {
  open: boolean
  pane: PaneSide | null
  onClose: () => void
}

/** Server selection dialog. The currently active terminal tab's server is
 *  pinned to the top and highlighted with an accent border. Picking a server
 *  connects it as a new tab in the target pane. */
export function ServerPicker({ open, pane, onClose }: ServerPickerProps) {
  const { tabs, activeTabId } = useSessionStore()
  const servers = useSftpStore((s) => s.servers)
  const connectServer = useSftpStore((s) => s.connectServer)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Resolve the active terminal tab's host as the "recommended" server.
  const activeTab = tabs.find((t) => t.id === activeTabId && t.kind === 'terminal')
  const recommendedId = activeTab?.host ? `${activeTab.host}:${activeTab.port ?? 22}` : null

  const ordered = [...servers].sort((a, b) => {
    const aMatch = `${a.host}:${a.port}` === recommendedId ? -1 : 0
    const bMatch = `${b.host}:${b.port}` === recommendedId ? 1 : 0
    return aMatch + bMatch
  })

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
          单击选中服务器，双击进行连接。当前终端会话的服务器已置顶并高亮。
        </div>
        <div className="sftp-picker-list">
          {ordered.map((s) => {
            const isRecommended = `${s.host}:${s.port}` === recommendedId
            const isSelected = s.id === selectedId
            const Icon = activeTab?.profileId ? resolveServerIcon('server') : ServerIcon
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
          })}
          {servers.length === 0 && (
            <div className="sftp-picker-empty">暂无可用服务器</div>
          )}
        </div>
      </div>
    </Dialog>
  )
}
