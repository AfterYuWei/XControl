import { useRef, useEffect } from 'react'
import { useSessionStore } from '@/store/session'

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab } = useSessionStore()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const check = () => {
      el.classList.toggle('has-overflow', el.scrollWidth > el.clientWidth + 4)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tabs.length])

  const dotClass = (status: string) =>
    status === 'connected' ? 'on' : status === 'connecting' ? 'loading' : 'off'

  return (
    <div className="tabbar">
      <div className="tabs-scroll" ref={scrollRef} role="tablist" aria-label="Terminal sessions">
        <div className="tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`sshx-tab ${tab.id === activeTabId ? 'active' : ''}`}
              role="tab"
              aria-selected={tab.id === activeTabId}
              tabIndex={tab.id === activeTabId ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className={`tab-dot ${dotClass(tab.status)}`} aria-hidden="true" />
              <span className="tab-name">{tab.profileName}</span>
              <button
                className="tab-x"
                title={`Close tab ${tab.profileName}`}
                aria-label={`Close tab ${tab.profileName}`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
