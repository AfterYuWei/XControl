import { useEffect, useState } from 'react'
import { Sidebar } from '@/components/Sidebar'
import { TerminalView } from '@/components/Terminal'
import { StatusBar } from '@/components/StatusBar'
import { ServerPanel } from '@/components/ServerPanel'
import { CommandPalette } from '@/components/CommandPalette'
import { Toast } from '@/components/Toast'
import { useProfileStore } from '@/store/profile'
import { useSessionStore } from '@/store/session'

export function Layout() {
  const { tabs } = useSessionStore()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const { fetchProfiles, fetchGroups } = useProfileStore()

  useEffect(() => {
    fetchProfiles()
    fetchGroups()
  }, [fetchProfiles, fetchGroups])

  // Global keyboard shortcuts: ⌘K palette, ⌘B sidebar, ⌘. panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
      if (meta && e.key === 'b') {
        e.preventDefault()
        setSidebarCollapsed((v) => !v)
      }
      if (meta && e.key === '.') {
        e.preventDefault()
        setPanelOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="sshx-app" role="application" aria-label="SSH Terminal Dashboard">
      {/* Sidebar */}
      <aside
        className={`sshx-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}
        role="navigation"
        aria-label="Server list"
      >
        <Sidebar />
      </aside>

      {/* Content */}
      <div className="cnt-wrap">
        <div className="expand-wrap">
          <button
            className="expand-btn"
            title="Show Sidebar (⌘B)"
            onClick={() => setSidebarCollapsed(false)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="3" y1="3" x2="3" y2="13" />
              <polyline points="7 5 11 8 7 11" />
            </svg>
          </button>
        </div>

        {tabs.length === 0 ? (
          <EmptyState />
        ) : (
          <TerminalView panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((v) => !v)} />
        )}

        <StatusBar />

        {/* Right Panel */}
        <ServerPanel open={panelOpen} onClose={() => setPanelOpen(false)} />
      </div>

      {/* Command Palette */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        onTogglePanel={() => setPanelOpen((v) => !v)}
      />

      {/* Toast */}
      <Toast />
    </div>
  )
}

function EmptyState() {
  return (
    <div className="term-empty-state" style={{ margin: '24px' }}>
      <div className="term-empty-icon">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <polyline points="3 5 6.5 8 3 11" />
          <line x1="8" y1="11" x2="13" y2="11" />
        </svg>
      </div>
      <div className="term-empty-title">SSH Terminal</div>
      <div className="term-empty-desc">
        从左侧选择一个服务器连接，或按 ⌘K 打开命令面板
      </div>
    </div>
  )
}
