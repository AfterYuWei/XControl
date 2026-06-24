import { useEffect, useState } from 'react'
import { useSessionStore } from '@/store/session'

export function StatusBar() {
  const { tabs, activeTabId } = useSessionStore()
  const [time, setTime] = useState('')

  const activeTab = tabs.find((t) => t.id === activeTabId)

  useEffect(() => {
    const update = () => {
      const d = new Date()
      setTime(
        d.toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
        })
      )
    }
    update()
    const timer = setInterval(update, 30000)
    return () => clearInterval(timer)
  }, [])

  const status = activeTab?.status ?? 'disconnected'
  const dotClass =
    status === 'connected' ? 'on' : status === 'connecting' ? 'loading' : 'off'
  const connText =
    status === 'connected'
      ? 'Connected'
      : status === 'connecting'
        ? 'Connecting…'
        : 'Disconnected'
  const path =
    activeTab && status === 'connected'
      ? `${activeTab.username || 'root'}@${activeTab.profileName}:~`
      : '—'

  return (
    <div className="statusbar">
      <div className="status-left">
        <div className="status-item">
          <span className={`status-dot-sm ${dotClass}`} />
          <span>{connText}</span>
        </div>
        <div className="status-item">
          <span>{path}</span>
        </div>
      </div>
      <div className="status-right">
        <div className="status-item">
          <span>UTF-8</span>
        </div>
        <div className="status-item">
          <span>{status === 'connected' ? '12ms' : '—'}</span>
        </div>
        <div className="status-item">
          <span>{time}</span>
        </div>
      </div>
    </div>
  )
}
