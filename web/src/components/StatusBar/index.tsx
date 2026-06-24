import { useEffect, useState } from 'react'
import { useSessionStore } from '@/store/session'

export function StatusBar() {
  const { tabs, activeTabId, setActiveTab, closeTab } = useSessionStore()
  const [time, setTime] = useState('')
  const [latency, setLatency] = useState<number | null>(null)

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const connected = activeTab?.status === 'connected'

  // Clock
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

  // Simulated latency for the active session while connected.
  // Replaced every few seconds so the status dot color reflects quality.
  // (No real ping transport exists yet; values are simulated.)
  useEffect(() => {
    if (!connected) {
      setLatency(null)
      return
    }
    const tick = () => setLatency(Math.floor(Math.random() * 340) + 10)
    tick()
    const id = setInterval(tick, 3000)
    return () => clearInterval(id)
  }, [connected, activeTabId])

  // Latency-driven color: green < 100ms, yellow 100–300ms, red > 300ms / offline
  const dotClass =
    !connected || latency === null
      ? 'off'
      : latency < 100
        ? 'on'
        : latency < 300
          ? 'loading'
          : 'off'

  return (
    <div className="statusbar">
      {/* Left: session switching */}
      <div className="status-left">
        {tabs.map((tab) => {
          const s = tab.status
          const dc = s === 'connected' ? 'on' : s === 'connecting' ? 'loading' : 'off'
          return (
            <div
              key={tab.id}
              className={`sb-tab ${tab.id === activeTabId ? 'active' : ''}`}
              role="tab"
              aria-selected={tab.id === activeTabId}
              tabIndex={tab.id === activeTabId ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              title={`${tab.profileName}${tab.host ? ` — ${tab.username ?? 'root'}@${tab.host}` : ''}`}
            >
              <span className={`sb-dot ${dc}`} aria-hidden="true" />
              <span className="sb-name">{tab.profileName}</span>
              <button
                className="sb-x"
                aria-label={`关闭会话 ${tab.profileName}`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>

      {/* Right: status dot (latency-driven) + latency + encoding + time */}
      <div className="status-right">
        <div className="status-item" title={connected ? `延迟 ${latency}ms` : '未连接'}>
          <span className={`status-dot-sm ${dotClass}`} />
          <span>{connected && latency !== null ? `${latency}ms` : '—'}</span>
        </div>
        <div className="status-item">
          <span>UTF-8</span>
        </div>
        <div className="status-item">
          <span>{time}</span>
        </div>
      </div>
    </div>
  )
}
