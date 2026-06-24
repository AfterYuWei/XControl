import { useRef, useEffect } from 'react'
import { useSessionStore } from '@/store/session'
import { ThemeToggle } from '@/components/ThemeToggle'

interface TabBarProps {
  onTogglePanel: () => void
  panelOpen: boolean
}

export function TabBar({ onTogglePanel, panelOpen }: TabBarProps) {
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
          <button
            className="tab-add"
            title="New Tab (⌘T)"
            aria-label="New terminal tab"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="6" y1="1" x2="6" y2="11" />
              <line x1="1" y1="6" x2="11" y2="6" />
            </svg>
          </button>
        </div>
      </div>
      <div className="tab-actions">
        <ThemeToggle />
        <button
          className={`tab-act ${panelOpen ? 'on' : ''}`}
          data-tip="Server Info (⌘.)"
          onClick={onTogglePanel}
          aria-label="Toggle server info panel"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
            <line x1="9.5" y1="1.5" x2="9.5" y2="14.5" />
          </svg>
        </button>
      </div>
    </div>
  )
}
