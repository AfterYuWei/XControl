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

  // Resolve the active terminal tab's host as the "recommended" server.
  const activeTab = tabs.find((t) => t.id === activeTabId && t.kind === 'terminal')
  const recommendedId = activeTab?.host ? `${activeTab.host}:${activeTab.port ?? 22}` : null

  const ordered = [...servers].sort((a, b) => {
    const aMatch = `${a.host}:${a.port}` === recommendedId ? -1 : 0
    const bMatch = `${b.host}:${b.port}` === recommendedId ? 1 : 0
    return aMatch + bMatch
  })

  const handlePick = (server: SftpServer) => {
    if (pane) connectServer(pane, server)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <div className="sftp-picker">
        <div className="sftp-picker-hdr">
          <span className="sftp-picker-title">选择服务器</span>
          <button className="sftp-picker-x" onClick={onClose} aria-label="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="sftp-picker-sub">
          选择要浏览文件的目标服务器，将以新标签页打开。当前终端会话的服务器已置顶并高亮。
        </div>
        <div className="sftp-picker-list">
          {ordered.map((s) => {
            const isRecommended = `${s.host}:${s.port}` === recommendedId
            const Icon = activeTab?.profileId ? resolveServerIcon('server') : ServerIcon
            return (
              <button
                key={s.id}
                className={`sftp-server-card ${isRecommended ? 'recommended' : ''}`}
                onClick={() => handlePick(s)}
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
              </button>
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
