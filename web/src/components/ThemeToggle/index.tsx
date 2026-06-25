import { Sun, Moon, Monitor } from 'lucide-react'
import { useSettingsStore } from '@/store/settings'

export function ThemeToggle({ className = 'tab-act' }: { className?: string }) {
  // 订阅 systemRevision：system 模式下系统主题变化时 store 会自增该值，
  // 触发本组件重渲染，使 isDark 与 tooltip 实时跟随系统深浅变化。
  const { theme, setTheme, systemRevision } = useSettingsStore()
  void systemRevision // 仅用于建立订阅依赖

  // Determine the currently resolved theme for the icon display
  const isDark =
    theme === 'dark' ||
    (theme === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)

  // 三态切换：light -> dark -> system -> light
  // 每个状态对应独立图标，system 用显示器图标，与深浅态视觉区分，单击即可识别当前模式
  const cycle = () => {
    if (theme === 'light') setTheme('dark')
    else if (theme === 'dark') setTheme('system')
    else setTheme('light')
  }

  const Icon = theme === 'system' ? Monitor : isDark ? Moon : Sun
  const label =
    theme === 'system'
      ? `Theme: System (${isDark ? 'Dark' : 'Light'})`
      : isDark
        ? 'Theme: Dark'
        : 'Theme: Light'

  return (
    <button
      className={className}
      data-tip={label}
      onClick={cycle}
      aria-label="Toggle theme"
    >
      <Icon size={13} />
    </button>
  )
}
