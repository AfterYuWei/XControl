import { Sun, Moon } from 'lucide-react'
import { useSettingsStore } from '@/store/settings'

export function ThemeToggle({ className = 'tab-act' }: { className?: string }) {
  const { theme, setTheme } = useSettingsStore()

  // Determine the currently resolved theme for the icon display
  const isDark =
    theme === 'dark' ||
    (theme === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)

  const cycle = () => {
    // light -> dark -> system -> light
    if (theme === 'light') setTheme('dark')
    else if (theme === 'dark') setTheme('system')
    else setTheme('light')
  }

  return (
    <button
      className={className}
      data-tip={theme === 'system' ? 'Theme: System' : isDark ? 'Theme: Dark' : 'Theme: Light'}
      onClick={cycle}
      aria-label="Toggle theme"
    >
      {isDark ? <Moon size={13} /> : <Sun size={13} />}
    </button>
  )
}
