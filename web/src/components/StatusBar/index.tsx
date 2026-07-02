import { useEffect, useState, useRef, useCallback } from 'react'
import { FolderUp, ChevronLeft, ChevronRight, KeyRound, Plus } from 'lucide-react'
import { useSessionStore } from '@/store/session'

export function StatusBar() {
  const { tabs, activeTabId, setActiveTab, closeTab, openDraftTab } = useSessionStore()
  const [time, setTime] = useState('')
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeStatus = activeTab?.status
  const connected = activeStatus === 'connected'
  const reconnecting = activeStatus === 'reconnecting'
  const errored = activeStatus === 'error'
  const latency = activeTab?.latency ?? null

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

  // Latency-driven color: green < 100ms, yellow 100–300ms, red > 300ms / offline.
  // Reconnecting takes precedence (yellow pulse); error forces off (red/gray).
  const dotClass =
    errored ? 'off'
    : reconnecting ? 'loading'
    : !connected || latency === null
      ? 'off'
      : latency < 100
        ? 'on'
        : latency < 300
          ? 'loading'
          : 'off'

  // Right-side status label: prefers lifecycle state over latency.
  const statusLabel =
    errored ? '已断开'
    : reconnecting
      ? (activeTab?.reconnectAttempt ? `重连中(${activeTab.reconnectAttempt})` : '重连中')
    : connected && latency !== null ? `${latency}ms`
    : '—'

  const statusTitle =
    errored ? (activeTab?.errorMessage || '已断开')
    : reconnecting ? '正在重连…'
    : connected ? (latency !== null ? `延迟 ${latency}ms` : '已连接')
    : '未连接'

  // Check scroll overflow and update arrow visibility
  const updateScrollState = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    updateScrollState()
    const ro = new ResizeObserver(updateScrollState)
    ro.observe(el)
    el.addEventListener('scroll', updateScrollState, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', updateScrollState)
    }
  }, [tabs, updateScrollState])

  // Scroll active tab into view when activeTabId changes
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const activeEl = el.querySelector('.sb-tab.active') as HTMLElement | null
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    }
  }, [activeTabId])

  const scrollBy = (direction: 'left' | 'right') => {
    const el = scrollRef.current
    if (!el) return
    const amount = el.clientWidth * 0.6
    el.scrollBy({ left: direction === 'left' ? -amount : amount, behavior: 'smooth' })
  }

  return (
    <div className="statusbar">
      {/* Left: session switching */}
      <div className="status-left">
        {canScrollLeft && (
          <button
            className="sb-arrow sb-arrow-left"
            aria-label="向左滚动标签"
            onClick={() => scrollBy('left')}
          >
            <ChevronLeft size={12} />
          </button>
        )}
        <div className="status-tabs" ref={scrollRef}>
          {tabs.map((tab) => {
          const s = tab.status
          const dc =
            s === 'connected' ? 'on'
            : s === 'connecting' ? 'loading'
            : s === 'reconnecting' ? 'loading'
            : 'off'
          const isSftp = tab.kind === 'sftp'
          const isVault = tab.kind === 'vault'
          return (
            <div
              key={tab.id}
              className={`sb-tab ${tab.id === activeTabId ? 'active' : ''} ${isSftp ? 'is-sftp' : ''} ${isVault ? 'is-vault' : ''}`}
              role="tab"
              aria-selected={tab.id === activeTabId}
              tabIndex={tab.id === activeTabId ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              title={isSftp ? 'SFTP 文件管理' : isVault ? 'Vault' : `${tab.profileName}${tab.host ? ` — ${tab.username ?? 'root'}@${tab.host}` : ''}`}
            >
              {isSftp ? (
                <FolderUp size={11} className="sb-dot-icon" aria-hidden="true" />
              ) : isVault ? (
                <KeyRound size={11} className="sb-dot-icon" aria-hidden="true" />
              ) : (
                <span className={`sb-dot ${dc}`} aria-hidden="true" />
              )}
              <span className="sb-name">{isSftp ? 'SFTP' : isVault ? 'Vaults' : tab.profileName}</span>
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
          <button
            className="sb-tab sb-tab-add"
            type="button"
            aria-label="新建连接标签页"
            title="新建连接标签页"
            onClick={() => openDraftTab()}
          >
            <Plus size={11} aria-hidden="true" />
          </button>
        </div>
        {canScrollRight && (
          <button
            className="sb-arrow sb-arrow-right"
            aria-label="向右滚动标签"
            onClick={() => scrollBy('right')}
          >
            <ChevronRight size={12} />
          </button>
        )}
      </div>

      {/* Right: status dot (latency-driven) + latency + encoding + time */}
      <div className="status-right">
        <div className="status-item" title={statusTitle}>
          <span className={`status-dot-sm ${dotClass}`} />
          <span>{statusLabel}</span>
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
