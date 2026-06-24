import { RefreshCw, RotateCcw, FolderTree, Copy } from 'lucide-react'
import { toast } from '@/store/toast'
import { useSessionStore } from '@/store/session'

interface ServerPanelProps {
  open: boolean
  onClose: () => void
}

export function ServerPanel({ open, onClose }: ServerPanelProps) {
  const { tabs, activeTabId } = useSessionStore()
  const activeTab = tabs.find((t) => t.id === activeTabId)

  const isOff = activeTab?.status === 'disconnected'
  const host = activeTab?.profileName ?? '—'
  const ip = activeTab?.host ?? '—'
  const user = activeTab?.username ?? 'root'

  const handleCopy = () => {
    if (activeTab?.host) {
      toast(`Copied: ssh ${user}@${activeTab.host}`)
    }
  }

  return (
    <aside className={`sshx-panel ${open ? 'open' : ''}`}>
      <div className="panel-hdr">
        <span>Server Info</span>
        <button className="panel-x" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </div>
      <div className="panel-body">
        {/* System Metrics — placeholder bars; real metrics require backend support */}
        <div className="psec">
          <div className="psec-title">System Metrics</div>
          <div className="metric" style={{ opacity: isOff ? 0.4 : 1 }}>
            <div className="m-head">
              <span className="m-label">CPU</span>
              <span className="m-val">—</span>
            </div>
            <div className="m-bar">
              <div className="m-fill cpu" style={{ width: 0 }} />
            </div>
          </div>
          <div className="metric" style={{ opacity: isOff ? 0.4 : 1 }}>
            <div className="m-head">
              <span className="m-label">Memory</span>
              <span className="m-val">—</span>
            </div>
            <div className="m-bar">
              <div className="m-fill mem" style={{ width: 0 }} />
            </div>
          </div>
          <div className="metric" style={{ opacity: isOff ? 0.4 : 1 }}>
            <div className="m-head">
              <span className="m-label">Disk</span>
              <span className="m-val">—</span>
            </div>
            <div className="m-bar">
              <div className="m-fill disk" style={{ width: 0 }} />
            </div>
          </div>
          <div className="metric" style={{ opacity: isOff ? 0.4 : 1 }}>
            <div className="m-head">
              <span className="m-label">Network</span>
              <span className="m-val">—</span>
            </div>
            <div className="m-bar">
              <div className="m-fill net" style={{ width: 0 }} />
            </div>
          </div>
        </div>

        {/* Session Info */}
        <div className="psec">
          <div className="psec-title">Session</div>
          <div className="info-row">
            <span className="info-label">User</span>
            <span className="info-val">{user}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Host</span>
            <span className="info-val">{host}</span>
          </div>
          <div className="info-row">
            <span className="info-label">IP</span>
            <span className="info-val">{ip}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Port</span>
            <span className="info-val">{activeTab?.port ?? '22'}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Status</span>
            <span className="info-val">
              {isOff ? 'Disconnected' : activeTab?.status === 'connecting' ? 'Connecting' : 'Connected'}
            </span>
          </div>
          <div className="info-row">
            <span className="info-label">Shell</span>
            <span className="info-val">/bin/bash</span>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="psec">
          <div className="psec-title">Quick Actions</div>
          <div className="act-btns">
            <button className="act-btn" onClick={() => toast('Reconnecting…')}>
              <RefreshCw size={13} />
              Reconnect
            </button>
            <button className="act-btn" onClick={() => toast('Session restarted')}>
              <RotateCcw size={13} />
              Restart Session
            </button>
            <button className="act-btn" onClick={() => toast('SFTP browser opened')}>
              <FolderTree size={13} />
              Open SFTP
            </button>
            <button className="act-btn" onClick={handleCopy}>
              <Copy size={13} />
              Copy SSH Command
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}
