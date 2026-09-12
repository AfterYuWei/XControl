import { useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Activity, ChevronLeft, ChevronRight, CloudSync, DatabaseBackup,
  Info, Palette, RefreshCw, SquareTerminal, Wifi,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { MobileHeader } from './MobileHeader'
import { useHeaderCollapse } from './useHeaderCollapse'
import { MobileAppearancePanel, MobileTerminalPanel, MobileUpdatePanel } from './MobileSettingsPanels'
import { BackupPanel } from '@/components/SettingsDialog/BackupPanel'
import { SyncPanel } from '@/components/SettingsDialog/SyncPanel'
import { AboutPanel } from '@/components/SettingsDialog/AboutPanel'
import { MobileDiagnosticsPanel } from '@/components/SettingsDialog/MobileDiagnosticsPanel'
import { useSettingsStore } from '@/store/settings'
import { terminalThemes } from '@/lib/terminalThemes'
import type { NativePlatform } from '@/lib/platform'

export type MobileSettingsSubPage =
  | 'appearance'
  | 'terminal'
  | 'backup'
  | 'sync'
  | 'diagnostics'
  | 'update'
  | 'about'

const THEME_LABELS = { light: '浅色', dark: '深色', system: '跟随系统' } as const

const SUB_TITLES: Record<MobileSettingsSubPage, string> = {
  appearance: '外观',
  terminal: '终端',
  backup: '数据备份',
  sync: '云同步',
  diagnostics: '诊断',
  update: '软件更新',
  about: '关于',
}

const MENU_ITEMS: Array<{
  key: MobileSettingsSubPage
  label: string
  desc: string
  icon: ComponentType<{ size?: number }>
}> = [
  { key: 'appearance', label: '外观', desc: '主题、字体与显示', icon: Palette },
  { key: 'terminal', label: '终端', desc: '主题、字体与补全', icon: SquareTerminal },
  { key: 'backup', label: '数据备份', desc: '导出与导入本地备份', icon: DatabaseBackup },
  { key: 'sync', label: '云同步', desc: '跨设备同步与版本控制', icon: CloudSync },
  { key: 'diagnostics', label: '诊断', desc: '网络与运行环境状态', icon: Activity },
  { key: 'update', label: '软件更新', desc: '版本、更新通道与自动检查', icon: RefreshCw },
  { key: 'about', label: '关于', desc: '版本与项目信息', icon: Info },
]

interface MobileSettingsPageProps {
  platform: NativePlatform
  connectedTabs: number
  subPage: MobileSettingsSubPage | null
  onOpenSubPage: (page: MobileSettingsSubPage) => void
  onBackFromSubPage: () => void
}

export function MobileSettingsPage({
  platform,
  connectedTabs,
  subPage,
  onOpenSubPage,
  onBackFromSubPage,
}: MobileSettingsPageProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const collapsed = useHeaderCollapse(scrollRef)
  const reducedMotion = useReducedMotion()
  const theme = useSettingsStore((state) => state.theme)
  const terminalTheme = useSettingsStore((state) => state.terminalTheme)
  const platformLabel = platform === 'android' ? 'Android 设备' : platform === 'ios' ? 'iPhone 与 iPad' : '移动设备'
  // 记录导航方向，二级页 push 从右滑入、pop 向右滑出（对称路径）
  const [navDir, setNavDir] = useState<'push' | 'pop'>('push')

  const openSub = (page: MobileSettingsSubPage) => {
    setNavDir('push')
    onOpenSubPage(page)
  }
  const backFromSub = () => {
    setNavDir('pop')
    onBackFromSubPage()
  }

  const menuSubtitle: Record<'appearance' | 'terminal', string> = {
    appearance: THEME_LABELS[theme],
    terminal: terminalThemes.find((t) => t.id === terminalTheme)?.label ?? '默认深色',
  }

  if (subPage) {
    return (
      <div className="m-page m-sub-host">
        <AnimatePresence initial={false}>
          <motion.div
            key={subPage}
            className="m-subpage"
            initial={reducedMotion
              ? { opacity: 0 }
              : navDir === 'push' ? { opacity: 0, x: '24%' } : { opacity: 0, x: '-24%' }}
            animate={{ opacity: 1, x: 0 }}
            exit={reducedMotion
              ? { opacity: 0 }
              : navDir === 'push' ? { opacity: 0, x: '-24%' } : { opacity: 0, x: '24%' }}
            transition={reducedMotion ? { duration: 0.2, ease: 'easeOut' } : { type: 'spring', bounce: 0, duration: 0.3 }}
          >
            <div className="m-subbar">
              <button type="button" className="m-subbar-back" aria-label="返回" onClick={backFromSub}>
                <ChevronLeft size={24} />
              </button>
              <span className="m-subbar-title">{SUB_TITLES[subPage]}</span>
            </div>
            <div className="m-page-scroll">
              <div className="m-page-body m-settings-flow">
                {subPage === 'appearance' && <MobileAppearancePanel />}
                {subPage === 'terminal' && <MobileTerminalPanel />}
                {subPage === 'backup' && <div className="m-subpanel"><BackupPanel /></div>}
                {subPage === 'sync' && <div className="m-subpanel"><SyncPanel /></div>}
                {subPage === 'diagnostics' && <div className="m-subpanel"><MobileDiagnosticsPanel /></div>}
                {subPage === 'update' && <MobileUpdatePanel />}
                {subPage === 'about' && <div className="m-subpanel"><AboutPanel /></div>}
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    )
  }

  return (
    <div className="m-page">
      <MobileHeader
        variant="large"
        title="我的"
        subtitle={platformLabel}
        collapsed={collapsed}
      />
      <div className="m-page-scroll" ref={scrollRef}>
        <div className="m-page-body m-settings-flow">
          <h2 className="m-eyebrow"><span>设置</span></h2>
          <div className="m-card">
            {MENU_ITEMS.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.key}
                  type="button"
                  className="m-set-row"
                  onClick={() => openSub(item.key)}
                >
                  <span className="m-set-row-icon is-settings"><Icon size={17} /></span>
                  <span className="m-set-row-copy">
                    <strong>{item.label}</strong>
                    <span>{menuSubtitle[item.key as 'appearance' | 'terminal'] ?? item.desc}</span>
                  </span>
                  <ChevronRight size={16} />
                </button>
              )
            })}
          </div>

          <h2 className="m-eyebrow"><span>连接状态</span></h2>
          <div className="m-card">
            <div className="m-set-row" aria-label="在线会话">
              <span className="m-set-row-icon is-settings"><Wifi size={17} /></span>
              <span className="m-set-row-copy">
                <strong>{connectedTabs ? `${connectedTabs} 个会话在线` : '暂无在线会话'}</strong>
                <span>凭据加密保存在此设备，返回前台后自动恢复连接</span>
              </span>
            </div>
          </div>

          <p className="m-platform-note">
            {platform === 'android'
              ? 'Android 会在后台通过可见通知提供最长 6 分钟的恢复窗口；系统仍可能提前冻结网络。'
              : 'iOS 后台恢复窗口最长 6 分钟，系统可能提前挂起网络连接。'}
          </p>
        </div>
      </div>
    </div>
  )
}
