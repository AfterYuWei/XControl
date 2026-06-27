import { useCallback, useEffect, useRef, useState } from 'react'
import { Search, X, FolderUp, Settings } from 'lucide-react'
import { Sidebar } from '@/components/Sidebar'
import { TerminalView } from '@/components/Terminal'
import { StatusBar } from '@/components/StatusBar'
import { CommandPalette } from '@/components/CommandPalette'
import { Toast } from '@/components/Toast'
import { ThemeToggle } from '@/components/ThemeToggle'
import { SettingsDialog } from '@/components/SettingsDialog'
import { useProfileStore } from '@/store/profile'
import { useSessionStore } from '@/store/session'
import { useSettingsStore } from '@/store/settings'
import { useWindowControls } from '@/hooks/useWindowControls'

export function Layout() {
  const { tabs, openSftpTab } = useSessionStore()
  const { sidebarWidth, setSidebarWidth } = useSettingsStore()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [resizing, setResizing] = useState(false)
  const sidebarRef = useRef<HTMLElement>(null)

  // Sidebar drag resize
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setResizing(true)
    const startX = e.clientX
    const startWidth = sidebarWidth

    const onMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX
      const newWidth = Math.min(480, Math.max(160, startWidth + delta))
      setSidebarWidth(newWidth)
    }

    const onMouseUp = () => {
      setResizing(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [sidebarWidth, setSidebarWidth])

  const { fetchProfiles, fetchGroups, searchQuery, setSearchQuery } = useProfileStore()

  // 桌面环境窗口控制：仅 Electron 下提供真实操作，浏览器下为 no-op
  // macOS 用系统原生交通灯（showControls=false），Windows/Linux 自绘右侧按钮
  const { desktop, mac, showControls, maximized, minimize, toggleMaximize, close } = useWindowControls()

  useEffect(() => {
    fetchProfiles()
    fetchGroups()
  }, [fetchProfiles, fetchGroups])

  // Global keyboard shortcuts: ⌘K palette, ⌘B sidebar
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
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="xcontrol-app" role="application" aria-label="Terminal">
      {/* Header — 自定义标题栏：棕色底、可拖拽窗口、搜索框居中、右侧窗口控制按钮。
          桌面环境(framework: false)下作为窗口标题栏；浏览器下仅作普通顶栏。 */}
      <header
        className={`xcontrol-header titlebar ${desktop ? 'is-desktop' : ''} ${mac ? 'is-mac' : ''}`}
      >
        {/* 左：折叠侧边栏 + SFTP。
            容器本身不加 no-drag，保留空白区域可拖拽窗口；
            具体按钮在 CSS 中声明 no-drag 以恢复点击。 */}
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
        </div>

        {/* 中：服务器搜索框。搜索框容器声明 no-drag，输入框可正常聚焦输入 */}
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

        {/* 右：设置 + 主题切换 */}
        <div className="header-right">
          <button
            className="tab-act"
            data-tip="设置"
            aria-label="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={13} />
          </button>
          <ThemeToggle className="tab-act" />
        </div>

        {/* 窗口控制按钮：仅 Windows/Linux 桌面环境渲染（macOS 用系统交通灯）。
            Windows 原生风格，关闭悬停变红。控制按钮区在 CSS 中声明 no-drag */}
        {showControls && (
          <div className="titlebar-controls">
            <button
              className="tb-btn tb-min"
              title="最小化"
              aria-label="Minimize"
              onClick={minimize}
            >
              <svg width="10" height="10" viewBox="0 0 10 10">
                <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
            <button
              className="tb-btn tb-max"
              title={maximized ? '还原' : '最大化'}
              aria-label={maximized ? 'Restore' : 'Maximize'}
              onClick={toggleMaximize}
            >
              {maximized ? (
                // 还原图标：两个重叠方框
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                  <rect x="0.5" y="2.5" width="6" height="6" />
                  <path d="M2.5 2.5 V0.5 H8.5 V6.5 H6.5" />
                </svg>
              ) : (
                // 最大化图标：单方框
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                  <rect x="0.5" y="0.5" width="9" height="9" />
                </svg>
              )}
            </button>
            <button
              className="tb-btn tb-close"
              title="关闭"
              aria-label="Close"
              onClick={close}
            >
              <svg width="10" height="10" viewBox="0 0 10 10">
                <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1" />
                <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
          </div>
        )}
      </header>

      {/* Body — sidebar + content */}
      <div className="xcontrol-body">
        {/* Sidebar */}
        <aside
          ref={sidebarRef}
          className={`xcontrol-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}
          role="navigation"
          aria-label="Server list"
        >
          <Sidebar />
        </aside>

        {/* Resize handle */}
        {!sidebarCollapsed && (
          <div
            className={`sidebar-resizer ${resizing ? 'active' : ''}`}
            onMouseDown={handleResizeStart}
          />
        )}

        {/* Content */}
        <div className="cnt-wrap">
          {tabs.length === 0 ? <EmptyState /> : <TerminalView />}
        </div>
      </div>

      {/* Status bar — full width */}
      <StatusBar />

      {/* Command Palette */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
      />

      {/* 设置面板 */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* Toast */}
      <Toast />
    </div>
  )
}

function EmptyState() {
  return (
    <div className="term-empty-state" style={{ margin: '0 8px' }}>
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
