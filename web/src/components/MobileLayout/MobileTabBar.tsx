import { motion, useReducedMotion } from 'motion/react'
import { Files, MonitorSmartphone, Server, Settings } from 'lucide-react'
import type { ComponentType } from 'react'

export type MobileSection = 'hosts' | 'sessions' | 'files' | 'settings'

const NAV_ITEMS: Array<{ id: MobileSection; label: string; icon: ComponentType<{ size?: number }> }> = [
  { id: 'hosts', label: '主机', icon: Server },
  { id: 'sessions', label: '会话', icon: MonitorSmartphone },
  { id: 'files', label: '文件', icon: Files },
  { id: 'settings', label: '设置', icon: Settings },
]

interface MobileTabBarProps {
  section: MobileSection
  sessionCount: number
  onNavigate: (section: MobileSection) => void
}

export function MobileTabBar({ section, sessionCount, onNavigate }: MobileTabBarProps) {
  const reducedMotion = useReducedMotion()
  return (
    <nav className="m-tabbar" aria-label="主要导航">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon
        const active = section === item.id
        return (
          <button
            key={item.id}
            type="button"
            className={`m-tab ${active ? 'is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
            // pointer-down 即响应（Apple Fluid §1），导航在按下瞬间发生
            onPointerDown={() => onNavigate(item.id)}
            onClick={(event) => event.preventDefault()}
          >
            {/* Telegram 风格整项选中药丸，layoutId 在标签间平滑平移（250ms） */}
            {active && (
              <motion.span
                layoutId="m-tab-glow"
                className="m-tab-glow"
                transition={
                  reducedMotion
                    ? { duration: 0.15 }
                    : { type: 'spring', bounce: 0, duration: 0.25 }
                }
              />
            )}
            <span className="m-tab-icon">
              <Icon size={20} />
              {item.id === 'sessions' && sessionCount > 0 && <b className="m-tab-badge">{sessionCount}</b>}
            </span>
            <span className="m-tab-label">{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
