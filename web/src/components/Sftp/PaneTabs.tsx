import { X, Plus } from 'lucide-react'
import { resolveServerIcon } from '@/lib/serverIcons'
import { useSftpStore } from './storeContext'
import { type PaneSide, type SftpTab } from '@/store/sftp'

interface PaneTabsProps {
  pane: PaneSide
  onPickServer: () => void
}

/** Multi-server tab strip. Both panes are symmetric: each tab is one
 *  connected server (the left pane starts with the local machine). The
 *  "+" opens the server picker to add another connection to this pane. */
export function PaneTabs({ pane, onPickServer }: PaneTabsProps) {
  const tabs = useSftpStore((s) => (pane === 'left' ? s.leftTabs : s.rightTabs))
  const activeId = useSftpStore((s) => (pane === 'left' ? s.activeLeftTabId : s.activeRightTabId))
  const setActiveTab = useSftpStore((s) => s.setActiveTab)
  const closeTab = useSftpStore((s) => s.closeTab)

  return (
    <div className="sftp-pane-hdr">
      <div className="sftp-tabs">
        {tabs.map((tab: SftpTab) => {
          const active = tab.id === activeId
          const Icon = resolveServerIcon('server')
          return (
            <div
              key={tab.id}
              className={`sftp-ptab ${active ? 'active' : ''}`}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => setActiveTab(pane, tab.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setActiveTab(pane, tab.id)
                }
              }}
              title={`${tab.server.name} — ${tab.server.username}@${tab.server.host}${tab.server.port ? ':' + tab.server.port : ''}`}
            >
              <Icon size={12} className="sftp-ptab-icon" />
              <span className="sftp-ptab-name">{tab.server.name}</span>
              <button
                className="sftp-ptab-x"
                aria-label={`断开 ${tab.server.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(pane, tab.id)
                }}
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
        <button
          className="sftp-ptab-add"
          title="连接新服务器"
          aria-label="连接新服务器"
          onClick={onPickServer}
        >
          <Plus size={13} />
        </button>
      </div>
    </div>
  )
}
