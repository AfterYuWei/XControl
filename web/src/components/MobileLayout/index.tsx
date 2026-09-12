import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { onBackButtonPress } from '@tauri-apps/api/app'
import { TerminalView } from '@/components/Terminal'
import { Toaster } from '@/components/ui/sonner'
import { useProfileStore } from '@/store/profile'
import { useSessionStore } from '@/store/session'
import { useSettingsStore } from '@/store/settings'
import { getPlatformCapabilities } from '@/lib/platform'
import { consumeMobileBackNavigation } from '@/lib/mobileBack'
import { isMobileKeyboardOpen } from '@/lib/mobileViewport'
import { IME_OPEN_THRESHOLD_PX, useImeInset } from '@/hooks/useMobileIme'
import { scheduleSilentMobileUpdateCheck } from '@/lib/mobileUpdate'
import { toast } from 'sonner'
import { MobileHeader } from './MobileHeader'
import { MobileTabBar, type MobileSection } from './MobileTabBar'
import { MobileEmpty } from './MobileEmpty'
import { MobileHostList } from './MobileHostList'
import { MobileSessionsPage } from './MobileSessionsPage'
import { MobileVaultPage } from './MobileVaultPage'
import { MobileSettingsPage, type MobileSettingsSubPage } from './MobileSettingsPage'
import { useSafeAreaInsets } from './useSafeArea'

const PAGE_SPRING = { type: 'spring', bounce: 0, duration: 0.3 } as const
/** reduced-motion：仅保留透明度淡入淡出，去除位移动画（skill §14）。 */
const PAGE_FADE = { duration: 0.2, ease: 'easeOut' } as const

/** TabBar 从左到右的空间顺序，用于推导页面平移方向（与选择轨迹一致）。 */
const SECTION_ORDER: readonly MobileSection[] = ['hosts', 'sessions', 'files', 'vault', 'settings']

export function MobileLayout() {
  const reducedMotion = useReducedMotion()
  const [section, setSection] = useState<MobileSection>('hosts')
  // 会话 tab 的层级：list 卡片列表 / terminal 终端页（放这里供 Android back 先弹这一层）
  const [sessionsLevel, setSessionsLevel] = useState<'list' | 'terminal'>('list')
  const [settingsSub, setSettingsSub] = useState<MobileSettingsSubPage | null>(null)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
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

  // 键盘检测：原生 IME insets 优先（adjustPan 下视口不收缩，visualViewport
  // 不可靠），插件不可用（iOS/浏览器预览）时回退视口高度差判断。
  const imeInset = useImeInset()
  const [imeSeen, setImeSeen] = useState(false)
  useEffect(() => {
    if (imeInset > 0) setImeSeen(true)
  }, [imeInset])
  // 一旦确认插件在报 IME（出现过非零值），键盘开合完全以原生 insets 为准
  useEffect(() => {
    if (imeSeen) setKeyboardOpen(imeInset > IME_OPEN_THRESHOLD_PX)
  }, [imeSeen, imeInset])

  useEffect(() => {
    const viewport = window.visualViewport
    const updateViewport = () => {
      const viewportHeight = viewport?.height ?? window.innerHeight
      document.documentElement.style.setProperty(
        '--mobile-viewport-height',
        `${viewportHeight}px`,
      )
      if (!imeSeen) setKeyboardOpen(isMobileKeyboardOpen(viewportHeight, window.innerHeight))
    }
    updateViewport()
    viewport?.addEventListener('resize', updateViewport)
    viewport?.addEventListener('scroll', updateViewport)
    return () => {
      viewport?.removeEventListener('resize', updateViewport)
      viewport?.removeEventListener('scroll', updateViewport)
      document.documentElement.style.removeProperty('--mobile-viewport-height')
    }
  }, [imeSeen])

  // 新建终端 tab（发起新连接）时自动进入会话终端页；切换/关闭已有 tab 不打扰当前层级。
  // 只对「首次激活」的 tab id 生效，避免关卡回退、pill 切换误触发。
  const knownTerminalIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (activeTab?.kind === 'sftp') go('files')
    if (activeTab?.kind === 'vault') go('vault')
    if (activeTab?.kind !== 'terminal') return
    if (knownTerminalIdsRef.current.has(activeTab.id)) return
    knownTerminalIdsRef.current.add(activeTab.id)
    go('sessions')
    setSessionsLevel('terminal')
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
        if (section === 'sessions' && sessionsLevel === 'terminal') {
          setSessionsLevel('list')
          return
        }
        go('hosts')
      }
    }).then((listener) => {
      unlisten = () => listener.unregister()
    })
    return () => void unlisten?.()
  }, [go, section, sessionsLevel, settingsSub])

  const navigate = (next: MobileSection) => {
    if (next === 'files') {
      const tab = tabs.find((candidate) => candidate.kind === 'sftp')
      if (tab) {
        setActiveTab(tab.id)
        // 已是激活 tab 时 kind 未变化、下方 effect 不会重跑，必须直接导航，
        // 否则「离开后再点回来」会出现点击无反应。
        if (tab.id === activeTabId) go(next)
      } else {
        openSftpTab()
      }
    } else if (next === 'vault') {
      const tab = tabs.find((candidate) => candidate.kind === 'vault')
      if (tab) {
        setActiveTab(tab.id)
        if (tab.id === activeTabId) go(next)
      } else {
        openVaultTab()
      }
    } else if (next === 'sessions') {
      // 会话 tab 固定回到一级列表，可预测
      setSessionsLevel('list')
      go(next)
    } else {
      go(next)
    }
  }

  const openSession = (tabId: string) => {
    setActiveTab(tabId)
    setSessionsLevel('terminal')
  }

  const closeTerminalTab = (tabId: string) => {
    const closingActiveTab = tabId === activeTabId
    const remainingTabs = terminalTabs.filter((tab) => tab.id !== tabId)
    closeTab(tabId)
    if (!closingActiveTab) return
    if (remainingTabs.length) {
      setActiveTab(remainingTabs.at(-1)!.id)
    } else {
      // 终端全部关闭：回到列表；若整个 tab 栈空了则回主机页
      setSessionsLevel('list')
      if (tabs.length === 1) go('hosts')
    }
  }

  return (
    <div
      className={`mobile-layout mobile-current-${section} ${
        section === 'sessions' && sessionsLevel === 'terminal' ? 'is-terminal-level' : ''
      } ${keyboardOpen ? 'is-keyboard-open' : ''}`}
      role="application"
      aria-label="eizhu 移动端"
    >
      <main className="mobile-main">
        {/* 整页平移跟随 TabBar 轨迹：新页与旧页同向滑动，无淡入淡出（custom 让离场页按最新方向滑出） */}
        <AnimatePresence initial={false} custom={slide.dir}>
          <motion.div
            key={section}
            className="m-page"
            custom={slide.dir}
            variants={{
              enter: (dir: number) =>
                reducedMotion ? { opacity: 0 } : { x: `${dir * 100}%` },
              center: { x: 0 },
              exit: (dir: number) =>
                reducedMotion ? { opacity: 0 } : { x: `${dir * -100}%` },
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
              <MobileSessionsPage
                level={sessionsLevel}
                onOpenSession={openSession}
                onBackToList={() => setSessionsLevel('list')}
                onGoHosts={() => go('hosts')}
                onCloseTab={closeTerminalTab}
              />
            )}

            {section === 'files' && (
              <div className="m-page-stack">
                <MobileHeader variant="compact" title="文件" />
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
