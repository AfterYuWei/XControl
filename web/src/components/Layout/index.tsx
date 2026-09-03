import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Search, X, FolderUp, Settings, KeyRound, Server } from 'lucide-react'
import { Sidebar } from '@/components/Sidebar'
import { TerminalView } from '@/components/Terminal'
import { StatusBar } from '@/components/StatusBar'
import { CommandPalette } from '@/components/CommandPalette'
import { ThemeToggle } from '@/components/ThemeToggle'
import { Toaster } from '@/components/ui/toast'
import { useProfileStore } from '@/store/profile'
import { useSessionStore } from '@/store/session'
import { useSettingsStore } from '@/store/settings'
import { useVaultStore } from '@/store/vault'
import { useWindowControls } from '@/hooks/useWindowControls'
import { profileApi } from '@/api/profile'
import { vaultApi } from '@/api/vault'
import type { Profile } from '@/types/profile'
import type { VaultItem } from '@/types/vault'

const SettingsDialog = lazy(() =>
  import('@/components/SettingsDialog').then((module) => ({ default: module.SettingsDialog })),
)

export function Layout() {
  const { tabs, openSftpTab, openVaultTab, openTab, setActiveTab } = useSessionStore()
  const { sidebarWidth, setSidebarWidth } = useSettingsStore()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [resizing, setResizing] = useState(false)
  const [globalSearch, setGlobalSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [profileResults, setProfileResults] = useState<Profile[]>([])
  const [vaultResults, setVaultResults] = useState<VaultItem[]>([])
  const sidebarRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)

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

  const {
    fetchProfiles,
    fetchGroups,
  } = useProfileStore()
  const {
    setSearchQuery: setVaultSearchQuery,
  } = useVaultStore()

  useEffect(() => {
    const query = globalSearch.trim()
    if (!query) {
      setProfileResults([])
      setVaultResults([])
      setSearching(false)
      return
    }

    let active = true
    setSearching(true)
    void Promise.all([
      profileApi.list({ search: query }),
      vaultApi.list({ q: query }),
    ])
      .then(([profiles, vaultItems]) => {
        if (!active) return
        setProfileResults(profiles ?? [])
        setVaultResults(vaultItems ?? [])
      })
      .catch(() => {
        if (!active) return
        setProfileResults([])
        setVaultResults([])
      })
      .finally(() => {
        if (active) setSearching(false)
      })

    return () => {
      active = false
    }
  }, [globalSearch])

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) setSearchOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [])

  const clearGlobalSearch = () => {
    setGlobalSearch('')
    setSearchOpen(false)
  }

  const handleProfileResult = (profile: Profile) => {
    clearGlobalSearch()
    const existing = tabs.find((tab) => tab.kind === 'terminal' && tab.profileId === profile.id)
    if (existing) {
      setActiveTab(existing.id)
      return
    }
    void openTab(profile.id, profile.name, profile.host, profile.port, profile.username)
  }

  const handleVaultResult = (item: VaultItem) => {
    setVaultSearchQuery(item.name)
    openVaultTab()
    clearGlobalSearch()
  }

  const hasSearchResults = profileResults.length > 0 || vaultResults.length > 0

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
      {/* Header — 自定义标题栏：主题色底、可拖拽窗口、搜索框居中、右侧窗口控制按钮。
          桌面环境(decorations:false)下作为窗口标题栏；浏览器下仅作普通顶栏。
          Tauri 拖拽：header 与各容器加 data-tauri-drag-region（仅对该元素自身的
          mousedown 生效），按钮/输入框等子元素不受影响。 */}
      <header
        className={`xcontrol-header titlebar ${desktop ? 'is-desktop' : ''} ${mac ? 'is-mac' : ''}`}
        data-tauri-drag-region={desktop || undefined}
      >
        {/* 左：折叠侧边栏 + SFTP。
            容器空白区域可拖拽窗口；具体按钮无 drag 属性保持可点击。 */}
        <div className="header-left" data-tauri-drag-region={desktop || undefined}>
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
            <span className="hdr-icon-btn-label">侧栏</span>
          </button>
          <button
            className="hdr-icon-btn"
            title="SFTP 文件管理"
            aria-label="打开 SFTP 文件管理"
            onClick={() => openSftpTab()}
          >
            <FolderUp size={14} />
            <span className="hdr-icon-btn-label">SFTP</span>
          </button>
          <button
            className="hdr-icon-btn"
            title="Vaults"
            aria-label="打开 Vault"
            onClick={() => openVaultTab()}
          >
            <KeyRound size={14} />
            <span className="hdr-icon-btn-label">Vaults</span>
          </button>
        </div>

        {/* 中：全局搜索服务器与 Vault 密钥。容器空白区域可拖拽，搜索框本身正常交互 */}
        <div className="header-center" data-tauri-drag-region={desktop || undefined}>
          <div ref={searchRef} className="header-search">
            <Search size={14} className="header-search-icon" />
            <input
              type="text"
              placeholder="搜索服务器或密钥…"
              autoComplete="off"
              spellCheck={false}
              value={globalSearch}
              onFocus={() => setSearchOpen(true)}
              onChange={(e) => {
                setGlobalSearch(e.target.value)
                setSearchOpen(true)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setSearchOpen(false)
              }}
            />
            {globalSearch && (
              <button
                className="header-search-clear"
                title="清除搜索"
                aria-label="清除搜索"
                onClick={clearGlobalSearch}
              >
                <X size={13} />
              </button>
            )}
            {searchOpen && globalSearch.trim() && (
              <div className="header-search-results" role="listbox" aria-label="全局搜索结果">
                {searching ? (
                  <div className="header-search-empty">搜索中…</div>
                ) : hasSearchResults ? (
                  <>
                    {profileResults.length > 0 && (
                      <div className="header-search-group">
                        <div className="header-search-group-title">服务器</div>
                        {profileResults.map((profile) => (
                          <button
                            key={profile.id}
                            type="button"
                            className="header-search-result"
                            role="option"
                            onClick={() => handleProfileResult(profile)}
                          >
                            <Server size={14} />
                            <span>
                              <strong>{profile.name}</strong>
                              <small>{profile.username}@{profile.host}:{profile.port}</small>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                    {vaultResults.length > 0 && (
                      <div className="header-search-group">
                        <div className="header-search-group-title">密钥</div>
                        {vaultResults.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="header-search-result"
                            role="option"
                            onClick={() => handleVaultResult(item)}
                          >
                            <KeyRound size={14} />
                            <span>
                              <strong>{item.name}</strong>
                              <small>
                                {item.type === 'private_key'
                                  ? '私钥'
                                  : `密码 · ${item.username || '需补充用户名'}`}
                              </small>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="header-search-empty">未找到匹配的服务器或密钥</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 右：设置 + 主题切换。容器空白区域可拖拽 */}
        <div className="header-right" data-tauri-drag-region={desktop || undefined}>
          <ThemeToggle className="hdr-icon-btn" showLabel buttonLabel="主题" />
          <button
            className="hdr-icon-btn"
            data-tip="设置"
            aria-label="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={13} />
            <span className="hdr-icon-btn-label">设置</span>
          </button>
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
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog open onOpenChange={setSettingsOpen} />
        </Suspense>
      )}

      {/* Toast — 右下角通知弹窗 */}
      <Toaster />
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
