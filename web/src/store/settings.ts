import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type Theme = 'light' | 'dark' | 'system'

interface SettingsStore {
  theme: Theme
  fontSize: number
  fontFamily: string
  sidebarWidth: number

  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setFontSize: (size: number) => void
  setFontFamily: (family: string) => void
  setSidebarWidth: (width: number) => void
}

function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return theme
}

function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme)
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(resolved)
}

// Watch OS-level theme changes so "system" mode reacts in real time.
let systemWatcher: ((e: MediaQueryListEvent) => void) | null = null
function ensureSystemWatcher() {
  if (systemWatcher) return
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = (e: MediaQueryListEvent) => {
    const { theme } = useSettingsStore.getState()
    if (theme === 'system') {
      const root = document.documentElement
      root.classList.remove('light', 'dark')
      root.classList.add(e.matches ? 'dark' : 'light')
    }
  }
  mql.addEventListener('change', handler)
  systemWatcher = handler
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
      sidebarWidth: 240,

      setTheme: (theme) => {
        set({ theme })
        applyTheme(theme)
      },
      toggleTheme: () => {
        const current = resolveTheme(get().theme)
        const next = current === 'dark' ? 'light' : 'dark'
        set({ theme: next })
        applyTheme(next)
      },
      setFontSize: (fontSize) => set({ fontSize }),
      setFontFamily: (fontFamily) => set({ fontFamily }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
    }),
    {
      name: 'sshx-settings',
    }
  )
)

// Apply theme on load
export function initTheme() {
  const theme = useSettingsStore.getState().theme
  applyTheme(theme)
  ensureSystemWatcher()
}
