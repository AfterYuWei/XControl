import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type Theme = 'light' | 'dark' | 'system'

interface SettingsStore {
  theme: Theme
  fontSize: number
  fontFamily: string
  sidebarWidth: number

  setTheme: (theme: Theme) => void
  setFontSize: (size: number) => void
  setFontFamily: (family: string) => void
  setSidebarWidth: (width: number) => void
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      theme: 'dark',
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      sidebarWidth: 260,

      setTheme: (theme) => {
        set({ theme })
        applyTheme(theme)
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

function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.classList.remove('light', 'dark')

  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.classList.add(prefersDark ? 'dark' : 'light')
  } else {
    root.classList.add(theme)
  }
}

// Apply theme on load
export function initTheme() {
  const theme = useSettingsStore.getState().theme
  applyTheme(theme)
}
