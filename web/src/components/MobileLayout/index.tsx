import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { onBackButtonPress } from '@tauri-apps/api/app'
import { MonitorSmartphone, X } from 'lucide-react'
import { TerminalView } from '@/components/Terminal'
import { Toaster } from '@/components/ui/sonner'
import { useProfileStore } from '@/store/profile'
import { useSessionStore } from '@/store/session'
import { useSettingsStore } from '@/store/settings'
import { getPlatformCapabilities } from '@/lib/platform'
import { consumeMobileBackNavigation } from '@/lib/mobileBack'
import { isMobileKeyboardOpen } from '@/lib/mobileViewport'
import { scheduleSilentMobileUpdateCheck } from '@/lib/mobileUpdate'
import { toast } from 'sonner'
import { MobileHeader } from './MobileHeader'
import { MobileTabBar, type MobileSection } from './MobileTabBar'
import { MobileEmpty } from './MobileEmpty'
import { MobileHostList } from './MobileHostList'
import { MobileVaultPage } from './MobileVaultPage'
import { MobileSettingsPage, type MobileSettingsSubPage } from './MobileSettingsPage'
import { useSafeAreaInsets } from './useSafeArea'

const STATUS_LABELS = {
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
  error: '连接异常',
  reconnecting: '重连中',
} as const

const PAGE_SPRING = { type: 'spring', bounce: 0, duration: 0.3 } as const
/** reduced-motion：仅保留透明度淡入淡出，去除位移动画（skill §14）。 */
const PAGE_FADE = { duration: 0.2, ease: 'easeOut' } as const

/** TabBar 从左到右的空间顺序，用于推导页面平移方向（与选择轨迹一致）。 */
const SECTION_ORDER: readonly MobileSection[] = ['hosts', 'sessions', 'files', 'vault', 'settings']

export function MobileLayout() {
  const reducedMotion = useReducedMotion()
  const [section, setSection] = useState<MobileSection>('hosts')
  const [settingsSub, setSettingsSub] = useState<MobileSettingsSubPage | null>(null)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const lastBackAt = useRef(0)
  const { fetchProfiles, fetchGroups } = useProfileStore()
  const { tabs, activeTabId, setActiveTab, openSftpTab, openVaultTab, closeTab } = useSessionStore()
  const theme = useSettingsStore((state) => state.theme)
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const terminalTabs = tabs.filter((tab) => tab.kind === 'terminal')
  const connectedTabs = terminalTabs.filter((tab) => tab.status === 'connected').length
  const platform = getPlatformCapabilities().platform

  // 平移方向跟随 TabBar 轨迹：目标 tab 在右侧 → 新页从右滑入、旧页向左滑出；往左切则镜像。
  // 前一个 index 存在 state 里，用函数式更新推导方向（不在渲染期读 ref）。
  const [slide, setSlide] = useState({ dir: 1, index: SECTION_ORDER.indexOf('hosts') })
  const go = useCallback((next: MobileSection) => {
    const nextIndex = SECTION_ORDER.indexOf(next)
    setSlide((prev) => ({ dir: nextIndex >= prev.index ? 1 : -1, index: nextIndex }))
    setSection(next)
  }, [])

  // 安全区：原生插件把状态栏/导航栏内边距写入 --safe-inset-*（Android WebView env() 恒为 0）
  useSafeAreaInsets()

  // 移动运行时标记：mobile.css 的 Portal 弹层规则依赖它，卸载时移除（桌面端不存在）
  useEffect(() => {
    document.documentElement.setAttribute('data-eizhu-mobile', '')
    return () => document.documentElement.removeAttribute('data-eizhu-mobile')
  }, [])

  // 启动静默检查更新（可开关设置控制；发现新版本 toast 引导下载）。
  // 仅启动时检查一次，开关变化不重复触发。
  useEffect(() => {
    scheduleSilentMobileUpdateCheck(useSettingsStore.getState().autoCheckUpdate)
  }, [])

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
    if (activeTab?.kind === 'terminal') go('sessions')
    if (activeTab?.kind === 'sftp') go('files')
    if (activeTab?.kind === 'vault') go('vault')
  }, [activeTab?.id, activeTab?.kind, go])

  useEffect(() => {
    if (getPlatformCapabilities().platform !== 'android') return
    let unlisten: (() => Promise<void>) | undefined
    void onBackButtonPress(() => {
      if (consumeMobileBackNavigation()) return
      if (settingsSub) {
        setSettingsSub(null)
        return
      }
      if (section !== 'hosts') {
        if (section === 'sessions' && activeTab?.kind === 'terminal') {
          const now = Date.now()
          if (now - lastBackAt.current < 2_000) {
            closeTab(activeTab.id)
            go('hosts')
          } else {
            lastBackAt.current = now
            toast('再次返回将断开当前终端')
          }
          return
        }
        go('hosts')
      }
    }).then((listener) => {
      unlisten = () => listener.unregister()
    })
    return () => void unlisten?.()
  }, [activeTab, closeTab, go, section, settingsSub])

  const navigate = (next: MobileSection) => {
    if (next === 'files') {
      const tab = tabs.find((candidate) => candidate.kind === 'sftp')
      if (tab) setActiveTab(tab.id)
      else openSftpTab()
    } else if (next === 'vault') {
      const tab = tabs.find((candidate) => candidate.kind === 'vault')
      if (tab) setActiveTab(tab.id)
      else openVaultTab()
    } else if (next === 'sessions') {
      const tab = activeTab?.kind === 'terminal' ? activeTab : terminalTabs.at(-1)
      if (tab) setActiveTab(tab.id)
      go(next)
    } else {
      go(next)
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
      go('hosts')
    }
  }

  const pageMeta = useMemo(() => {
    if (section === 'files') {
      return { title: '文件' }
    }
    return {
      title: activeTab?.kind === 'terminal' ? activeTab.profileName : '终端',
      subtitle: terminalTabs.length
        ? `${connectedTabs}/${terminalTabs.length} 个会话在线`
        : undefined,
    }
  }, [activeTab, connectedTabs, section, terminalTabs.length])

  return (
    <div
      className={`mobile-layout mobile-current-${section} ${keyboardOpen ? 'is-keyboard-open' : ''}`}
      role="application"
      aria-label="eizhu 移动端"
    >
      <main className="mobile-main">
        {/* 平移跟随 TabBar 轨迹：custom 让离场页也按最新方向滑出（可随时打断） */}
        <AnimatePresence initial={false} custom={slide.dir}>
          <motion.div
            key={section}
            className="m-page"
            custom={slide.dir}
            variants={{
              enter: (dir: number) =>
                reducedMotion ? { opacity: 0 } : { opacity: 0, x: `${dir * 24}%` },
              center: { opacity: 1, x: 0 },
              exit: (dir: number) =>
                reducedMotion ? { opacity: 0 } : { opacity: 0, x: `${dir * -24}%` },
            }}
            initial="enter"
            animate="center"
            exit="exit"
            transition={reducedMotion ? PAGE_FADE : PAGE_SPRING}
          >
            {section === 'hosts' && (
              <div className="m-host-master">
                <MobileHostList />
                <div className="m-host-detail">
                  {terminalTabs.length ? <TerminalView /> : <MobileEmpty title="选择一台主机" />}
                </div>
              </div>
            )}

            {section === 'sessions' && (
              <div className="m-page-stack">
                <MobileHeader
                  variant="compact"
                  title={pageMeta.title}
                  subtitle={pageMeta.subtitle}
                  trailing={activeTab?.kind === 'terminal' && (
                    <span className={`m-state-pill`}>
                      <span className={`m-dot is-${activeTab.status}`} />
                      {STATUS_LABELS[activeTab.status]}
                    </span>
                  )}
                />
                {terminalTabs.length > 0 && (
                  <div className="m-chips" role="tablist">
                    {terminalTabs.map((tab) => (
                      <div key={tab.id} className={`m-chip ${tab.id === activeTabId ? 'is-active' : ''}`}>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={tab.id === activeTabId}
                          className="m-chip-select"
                          onPointerDown={() => setActiveTab(tab.id)}
                        >
                          <span className={`m-dot m-chip-dot is-${tab.status}`} />
                          <span className="m-chip-name">{tab.profileName}</span>
                        </button>
                        <button
                          type="button"
                          className="m-chip-close"
                          aria-label={`关闭 ${tab.profileName}`}
                          onPointerDown={() => closeTerminalTab(tab.id)}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="m-session-content">
                  {terminalTabs.length
                    ? <TerminalView />
                    : <MobileEmpty
                        icon={MonitorSmartphone}
                        title="暂无终端会话"
                        description="从主机页选择一台服务器连接。"
                        action={<button type="button" className="m-empty-action" onClick={() => go('hosts')}>选择主机</button>}
                      />}
                </div>
              </div>
            )}

            {section === 'files' && (
              <div className="m-page-stack">
                <MobileHeader variant="compact" title={pageMeta.title} subtitle={pageMeta.subtitle} />
                <div className="m-page-fill"><TerminalView /></div>
              </div>
            )}

            {section === 'vault' && (
              <MobileVaultPage />
            )}

            {section === 'settings' && (
              <MobileSettingsPage
                platform={platform}
                connectedTabs={connectedTabs}
                subPage={settingsSub}
                onOpenSubPage={setSettingsSub}
                onBackFromSubPage={() => setSettingsSub(null)}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      <MobileTabBar section={section} sessionCount={terminalTabs.length} onNavigate={navigate} />

      <Toaster
        position="top-center"
        theme={theme === 'system'
          ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : theme}
      />
    </div>
  )
}
