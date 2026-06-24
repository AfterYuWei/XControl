import { useEffect, useState } from 'react'
import { Search, X, FolderUp } from 'lucide-react'
import { Sidebar } from '@/components/Sidebar'
import { TerminalView } from '@/components/Terminal'
import { StatusBar } from '@/components/StatusBar'
import { ServerPanel } from '@/components/ServerPanel'
import { CommandPalette } from '@/components/CommandPalette'
import { Toast } from '@/components/Toast'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useProfileStore } from '@/store/profile'
import { useSessionStore } from '@/store/session'

export function Layout() {
  const { tabs, openSftpTab } = useSessionStore()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const { fetchProfiles, fetchGroups, searchQuery, setSearchQuery } = useProfileStore()

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
    <div className="sshx-app" role="application" aria-label="Terminal">
      {/* Header — full width, left/center/right layout */}
      <header className="sshx-header">
        {/* Left: collapse sidebar + theme toggle (migrated from sidebar toolbar) */}
        <div className="header-left">
          <button
            className="hdr-icon-btn"
            title={sidebarCollapsed ? '展开侧边栏 (⌘B)' : '折叠侧边栏 (⌘B)'}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setSidebarCollapsed((v) => !v)}
          >
            {sidebarCollapsed ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="3" x2="3" y2="13" />
                <polyline points="7 5 11 8 7 11" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="12" height="10" rx="1.5" />
                <line x1="6" y1="3" x2="6" y2="13" />
              </svg>
            )}
          </button>
          <button
            className="hdr-icon-btn"
            title="SFTP 文件管理"
            aria-label="打开 SFTP 文件管理"
            onClick={() => openSftpTab()}
          >
            <FolderUp size={14} />
          </button>
          <ThemeToggle className="hdr-icon-btn" />
        </div>

        {/* Center: server search */}
        <div className="header-center">
          <div className="header-search">
            <Search size={14} className="header-search-icon" />
            <input
              type="text"
              placeholder="搜索服务器…"
              autoComplete="off"
              spellCheck={false}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                className="header-search-clear"
                title="清除搜索"
                aria-label="清除搜索"
                onClick={() => setSearchQuery('')}
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>

        {/* Right: server info panel toggle (migrated from tabbar toolbar) */}
        <div className="header-right">
          <button
            className={`tab-act ${panelOpen ? 'on' : ''}`}
            data-tip="Server Info (⌘.)"
            onClick={() => setPanelOpen((v) => !v)}
            aria-label="Toggle server info panel"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
              <line x1="9.5" y1="1.5" x2="9.5" y2="14.5" />
            </svg>
          </button>
        </div>
      </header>

      {/* Body — sidebar + content */}
      <div className="sshx-body">
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
          {tabs.length === 0 ? <EmptyState /> : <TerminalView panelOpen={panelOpen} />}

          {/* Right Panel */}
          <ServerPanel open={panelOpen} onClose={() => setPanelOpen(false)} />
        </div>
      </div>

      {/* Status bar — full width */}
      <StatusBar />

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
    <div className="term-empty-state" style={{ margin: '8px 8px 2px 8px' }}>
      <div className="term-empty-icon">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <polyline points="3 5 6.5 8 3 11" />
          <line x1="8" y1="11" x2="13" y2="11" />
        </svg>
      </div>
      <div className="term-empty-title">暂无活跃会话</div>
      <div className="term-empty-desc">
        从左侧选择一个服务器连接，或按 ⌘K 打开命令面板
      </div>
    </div>
  )
}
