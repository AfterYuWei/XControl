import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Files, KeyRound, MonitorSmartphone, Server, Settings } from 'lucide-react'
import { onBackButtonPress } from '@tauri-apps/api/app'
import { Sidebar } from '@/components/Sidebar'
import { TerminalView } from '@/components/Terminal'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { useProfileStore } from '@/store/profile'
import { useSessionStore } from '@/store/session'
import { useSettingsStore } from '@/store/settings'
import { getPlatformCapabilities } from '@/lib/platform'
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

export function MobileLayout() {
  const [section, setSection] = useState<MobileSection>('hosts')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [vaultOpen, setVaultOpen] = useState(false)
  const lastBackAt = useRef(0)
  const { fetchProfiles, fetchGroups } = useProfileStore()
  const { tabs, activeTabId, setActiveTab, openSftpTab, openVaultTab, closeTab } = useSessionStore()
  const theme = useSettingsStore((state) => state.theme)
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const terminalTabs = tabs.filter((tab) => tab.kind === 'terminal')

  useEffect(() => {
    void fetchProfiles()
    void fetchGroups()
  }, [fetchGroups, fetchProfiles])

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
      document.documentElement.style.setProperty(
        '--mobile-viewport-height',
        `${viewport?.height ?? window.innerHeight}px`,
      )
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
    } else {
      setSection(next)
    }
  }

  return (
    <div className="mobile-layout" role="application" aria-label="eizhu 移动端">
      <header className="mobile-header">
        <div>
          <span className="mobile-eyebrow">eizhu mobile</span>
          <h1>{NAV_ITEMS.find((item) => item.id === section)?.label}</h1>
        </div>
        {section === 'sessions' && activeTab?.kind === 'terminal' && (
          <span className={`mobile-session-state is-${activeTab.status}`}>{activeTab.status}</span>
        )}
      </header>

      <main className={`mobile-main mobile-section-${section}`}>
        {section === 'hosts' && (
          <div className="mobile-host-master">
            <div className="mobile-host-list"><Sidebar /></div>
            <div className="mobile-tablet-detail">
              {tabs.length ? <TerminalView /> : <MobileEmpty text="选择主机开始连接" />}
            </div>
          </div>
        )}
        {section === 'sessions' && (
          <div className="mobile-session-page">
            {terminalTabs.length > 0 && (
              <div className="mobile-session-tabs" role="tablist">
                {terminalTabs.map((tab) => (
                  <Button
                    key={tab.id}
                    type="button"
                    variant={tab.id === activeTabId ? 'secondary' : 'ghost'}
                    className="mobile-session-tab"
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.profileName}
                  </Button>
                ))}
              </div>
            )}
            <div className="mobile-session-content">
              {terminalTabs.length ? <TerminalView /> : <MobileEmpty text="暂无终端会话" />}
            </div>
          </div>
        )}
        {section === 'files' && <TerminalView />}
        {section === 'settings' && vaultOpen && (
          <div className="mobile-vault-page">
            <Button variant="ghost" className="mobile-vault-back" onClick={() => setVaultOpen(false)}>返回设置</Button>
            <div className="mobile-vault-content"><TerminalView /></div>
          </div>
        )}
        {section === 'settings' && !vaultOpen && (
          <div className="mobile-settings-page">
            <Button variant="outline" className="mobile-settings-action" onClick={() => { openVaultTab(); setVaultOpen(true) }}>
              <KeyRound /> Vault 与凭据
            </Button>
            <Button variant="outline" className="mobile-settings-action" onClick={() => setSettingsOpen(true)}>
              <Settings /> 应用设置
            </Button>
            <p>iOS 后台恢复窗口最长 6 分钟，系统可能提前挂起网络连接；返回前台后会自动恢复。</p>
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
              onClick={() => navigate(item.id)}
            >
              <Icon size={20} />
              <span>{item.label}</span>
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

function MobileEmpty({ text }: { text: string }) {
  return <div className="mobile-empty">{text}</div>
}
