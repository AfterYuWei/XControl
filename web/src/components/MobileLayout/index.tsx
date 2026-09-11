import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ChevronRight,
  Files,
  KeyRound,
  MonitorSmartphone,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Wifi,
  X,
} from 'lucide-react'
import { onBackButtonPress } from '@tauri-apps/api/app'
import { Sidebar } from '@/components/Sidebar'
import { TerminalView } from '@/components/Terminal'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { useProfileStore } from '@/store/profile'
import { useSessionStore } from '@/store/session'
import { useSettingsStore } from '@/store/settings'
import { getPlatformCapabilities } from '@/lib/platform'
import { consumeMobileBackNavigation } from '@/lib/mobileBack'
import { isMobileKeyboardOpen } from '@/lib/mobileViewport'
import { toast } from 'sonner'

const SettingsDialog = lazy(() =>
  import('@/components/SettingsDialog').then((module) => ({ default: module.SettingsDialog })),
)

type MobileSection = 'hosts' | 'sessions' | 'files' | 'settings'

const NAV_ITEMS: Array<{ id: MobileSection; label: string; icon: typeof Server }> = [
  { id: 'hosts', label: '主机', icon: Server },
  { id: 'sessions', label: '会话', icon: MonitorSmartphone },
  { id: 'files', label: '文件', icon: Files },
  { id: 'settings', label: '设置', icon: Settings },
]

const STATUS_LABELS = {
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
  error: '连接异常',
  reconnecting: '重连中',
} as const

export function MobileLayout() {
  const [section, setSection] = useState<MobileSection>('hosts')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [vaultOpen, setVaultOpen] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [hostQuery, setHostQuery] = useState('')
  const lastBackAt = useRef(0)
  const { profiles, searchQuery, setSearchQuery, fetchProfiles, fetchGroups } = useProfileStore()
  const { tabs, activeTabId, setActiveTab, openSftpTab, openVaultTab, closeTab } = useSessionStore()
  const theme = useSettingsStore((state) => state.theme)
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const terminalTabs = tabs.filter((tab) => tab.kind === 'terminal')
  const sftpTabs = tabs.filter((tab) => tab.kind === 'sftp')
  const connectedTabs = terminalTabs.filter((tab) => tab.status === 'connected').length
  const platform = getPlatformCapabilities().platform
  const pageMeta = useMemo(() => {
    if (section === 'hosts') {
      return { title: '连接', subtitle: `${profiles.length} 台主机` }
    }
    if (section === 'sessions') {
      return {
        title: activeTab?.kind === 'terminal' ? activeTab.profileName : '终端',
        subtitle: terminalTabs.length ? `${connectedTabs}/${terminalTabs.length} 个会话在线` : '安全远程终端',
      }
    }
    if (section === 'files') {
      return { title: '文件', subtitle: sftpTabs.length ? 'SFTP 文件管理' : '选择服务器浏览文件' }
    }
    return { title: '我的', subtitle: platform === 'android' ? 'Android 设备' : 'iPhone 与 iPad' }
  }, [activeTab, connectedTabs, platform, profiles.length, section, sftpTabs.length, terminalTabs.length])

  useEffect(() => {
    void fetchProfiles()
    void fetchGroups()
  }, [fetchGroups, fetchProfiles])

  useEffect(() => {
    if (hostQuery === searchQuery) return
    const timer = window.setTimeout(() => setSearchQuery(hostQuery), 250)
    return () => window.clearTimeout(timer)
  }, [hostQuery, searchQuery, setSearchQuery])

  useEffect(() => {
    const capabilities = getPlatformCapabilities()
    if (capabilities.platform !== 'android') return
    const guideKey = 'eizhu-android-battery-guide-v1'
    if (!localStorage.getItem(guideKey)) {
      localStorage.setItem(guideKey, 'shown')
      toast('后台连接提示', {
        description: '部分国产 Android 系统会强制冻结后台应用。如会话频繁中断，请在系统电池设置中允许 eizhu 后台运行；应用不会自动修改系统设置。',
        duration: 12_000,
      })
    }
    const notificationLimited = (event: Event) => {
      const message = (event as CustomEvent<string>).detail
      toast.warning('通知权限未开启', {
        description: message || '后台恢复窗口可能无法可靠运行，请在系统设置中允许通知。',
        duration: 10_000,
      })
    }
    window.addEventListener('eizhu:notification-limited', notificationLimited)
    return () => window.removeEventListener('eizhu:notification-limited', notificationLimited)
  }, [])

  useEffect(() => {
    const viewport = window.visualViewport
    const updateViewport = () => {
      const viewportHeight = viewport?.height ?? window.innerHeight
      document.documentElement.style.setProperty(
        '--mobile-viewport-height',
        `${viewportHeight}px`,
      )
      setKeyboardOpen(isMobileKeyboardOpen(viewportHeight, window.innerHeight))
    }
    updateViewport()
    viewport?.addEventListener('resize', updateViewport)
    viewport?.addEventListener('scroll', updateViewport)
    return () => {
      viewport?.removeEventListener('resize', updateViewport)
      viewport?.removeEventListener('scroll', updateViewport)
      document.documentElement.style.removeProperty('--mobile-viewport-height')
    }
  }, [])

  useEffect(() => {
    if (activeTab?.kind === 'terminal') setSection('sessions')
    if (activeTab?.kind === 'sftp') setSection('files')
    if (activeTab?.kind === 'vault') setSection('settings')
  }, [activeTab?.id, activeTab?.kind])

  useEffect(() => {
    if (getPlatformCapabilities().platform !== 'android') return
    let unlisten: (() => Promise<void>) | undefined
    void onBackButtonPress(() => {
      if (consumeMobileBackNavigation()) return
      if (settingsOpen) {
        setSettingsOpen(false)
        return
      }
      if (vaultOpen) {
        setVaultOpen(false)
        return
      }
      if (section !== 'hosts') {
        if (section === 'sessions' && activeTab?.kind === 'terminal') {
          const now = Date.now()
          if (now - lastBackAt.current < 2_000) {
            closeTab(activeTab.id)
            setSection('hosts')
          } else {
            lastBackAt.current = now
            toast('再次返回将断开当前终端')
          }
          return
        }
        setSection('hosts')
      }
    }).then((listener) => {
      unlisten = () => listener.unregister()
    })
    return () => void unlisten?.()
  }, [activeTab, closeTab, section, settingsOpen, vaultOpen])

  const navigate = (next: MobileSection) => {
    if (next === 'files') {
      const tab = tabs.find((candidate) => candidate.kind === 'sftp')
      if (tab) setActiveTab(tab.id)
      else openSftpTab()
    } else if (next === 'sessions') {
      const tab = activeTab?.kind === 'terminal' ? activeTab : terminalTabs.at(-1)
      if (tab) setActiveTab(tab.id)
      setSection(next)
    } else {
      setSection(next)
    }
  }

  const closeTerminalTab = (tabId: string) => {
    const closingActiveTab = tabId === activeTabId
    const remainingTabs = terminalTabs.filter((tab) => tab.id !== tabId)
    closeTab(tabId)
    if (!closingActiveTab) return
    if (remainingTabs.length) {
      setActiveTab(remainingTabs.at(-1)!.id)
    } else if (tabs.length === 1) {
      setSection('hosts')
    }
  }

  return (
    <div
      className={`mobile-layout mobile-current-${section} ${keyboardOpen ? 'is-keyboard-open' : ''}`}
      role="application"
      aria-label="eizhu 移动端"
    >
      <header className="mobile-header">
        <div className="mobile-brand-mark" aria-hidden="true">E</div>
        <div className="mobile-header-copy">
          <h1>{pageMeta.title}</h1>
          <span>{pageMeta.subtitle}</span>
        </div>
        {section === 'sessions' && activeTab?.kind === 'terminal' && (
          <span className={`mobile-session-state is-${activeTab.status}`}>
            <span className="mobile-status-dot" />
            {STATUS_LABELS[activeTab.status]}
          </span>
        )}
        {section !== 'sessions' && <span className="mobile-header-wordmark">eizhu</span>}
      </header>

      <main className={`mobile-main mobile-section-${section}`}>
        {section === 'hosts' && (
          <div className="mobile-host-master">
            <div className="mobile-host-list">
              <label className="mobile-search">
                <Search size={17} aria-hidden="true" />
                <input
                  type="search"
                  value={hostQuery}
                  placeholder="搜索名称、地址或标签"
                  aria-label="搜索主机"
                  onChange={(event) => setHostQuery(event.target.value)}
                />
                {hostQuery && (
                  <button type="button" aria-label="清除搜索" onClick={() => setHostQuery('')}>
                    <X size={15} />
                  </button>
                )}
              </label>
              <div className="mobile-sidebar-content"><Sidebar /></div>
            </div>
            <div className="mobile-tablet-detail">
              {terminalTabs.length ? <TerminalView /> : <MobileEmpty text="选择主机开始连接" />}
            </div>
          </div>
        )}
        {section === 'sessions' && (
          <div className="mobile-session-page">
            {terminalTabs.length > 0 && (
              <div className="mobile-session-tabs" role="tablist">
                {terminalTabs.map((tab) => (
                  <div key={tab.id} className={`mobile-session-tab ${tab.id === activeTabId ? 'is-active' : ''}`}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab.id === activeTabId}
                      className="mobile-session-tab-select"
                      onClick={() => setActiveTab(tab.id)}
                    >
                      <span className={`mobile-tab-dot is-${tab.status}`} />
                      <span>{tab.profileName}</span>
                    </button>
                    <button
                      type="button"
                      className="mobile-session-tab-close"
                      aria-label={`关闭 ${tab.profileName}`}
                      onClick={() => closeTerminalTab(tab.id)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="mobile-session-content">
              {terminalTabs.length
                ? <TerminalView />
                : <MobileEmpty icon={MonitorSmartphone} text="暂无终端会话" description="从连接页选择一台主机，即可开始安全会话。" action="选择主机" onAction={() => setSection('hosts')} />}
            </div>
          </div>
        )}
        {section === 'files' && <TerminalView />}
        {section === 'settings' && vaultOpen && (
          <div className="mobile-vault-page">
            <Button variant="ghost" className="mobile-vault-back" onClick={() => setVaultOpen(false)}>‹ 返回我的</Button>
            <div className="mobile-vault-content"><TerminalView /></div>
          </div>
        )}
        {section === 'settings' && !vaultOpen && (
          <div className="mobile-settings-page">
            <section className="mobile-overview-card" aria-label="运行状态">
              <div className="mobile-overview-icon"><ShieldCheck size={22} /></div>
              <div>
                <strong>本地安全空间</strong>
                <span>凭据加密保存在此设备</span>
              </div>
              <span className="mobile-overview-badge">正常</span>
            </section>
            <h2>管理</h2>
            <div className="mobile-settings-group">
              <button type="button" className="mobile-settings-action" onClick={() => { openVaultTab(); setVaultOpen(true) }}>
                <span className="mobile-settings-icon is-vault"><KeyRound /></span>
                <span><strong>Vault 与凭据</strong><small>密码、密钥与安全存储</small></span>
                <ChevronRight />
              </button>
              <button type="button" className="mobile-settings-action" onClick={() => setSettingsOpen(true)}>
                <span className="mobile-settings-icon is-settings"><Settings /></span>
                <span><strong>应用设置</strong><small>外观、终端、备份与同步</small></span>
                <ChevronRight />
              </button>
            </div>
            <h2>连接状态</h2>
            <div className="mobile-status-card">
              <Wifi size={18} />
              <span><strong>{connectedTabs ? `${connectedTabs} 个会话在线` : '暂无在线会话'}</strong><small>返回前台后自动检查并恢复连接</small></span>
              <Activity size={17} />
            </div>
            <p className="mobile-platform-note">
              {platform === 'android'
                ? 'Android 会在后台通过可见通知提供最长 6 分钟的恢复窗口；系统仍可能提前冻结网络。'
                : 'iOS 后台恢复窗口最长 6 分钟，系统可能提前挂起网络连接。'}
            </p>
          </div>
        )}
      </main>

      <nav className="mobile-bottom-nav" aria-label="主要导航">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              className={section === item.id ? 'is-active' : ''}
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id)}
            >
              <Icon size={20} />
              <span>{item.label}</span>
              {item.id === 'sessions' && terminalTabs.length > 0 && <b>{terminalTabs.length}</b>}
            </button>
          )
        })}
      </nav>

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog open onOpenChange={setSettingsOpen} />
        </Suspense>
      )}
      <Toaster
        position="top-center"
        theme={theme === 'system'
          ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : theme}
      />
    </div>
  )
}

function MobileEmpty({
  text,
  description,
  action,
  onAction,
  icon: Icon = Server,
}: {
  text: string
  description?: string
  action?: string
  onAction?: () => void
  icon?: typeof Server
}) {
  return (
    <div className="mobile-empty">
      <span className="mobile-empty-icon"><Icon size={24} /></span>
      <strong>{text}</strong>
      {description && <p>{description}</p>}
      {action && onAction && <Button onClick={onAction}>{action}</Button>}
    </div>
  )
}
