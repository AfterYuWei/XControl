import { lazy, Suspense, type CSSProperties } from 'react'
import { useSessionStore } from '@/store/session'
import { useSettingsStore, useResolvedTheme } from '@/store/settings'
import { getTerminalThemeMeta, resolveTerminalThemeId } from '@/lib/terminalThemes'

const TerminalPane = lazy(() =>
  import('./TerminalPane').then((module) => ({ default: module.TerminalPane })),
)
const SftpView = lazy(() =>
  import('@/components/Sftp/SftpView').then((module) => ({ default: module.SftpView })),
)
const VaultView = lazy(() =>
  import('@/components/Vault/VaultView').then((module) => ({ default: module.VaultView })),
)

/** Content router: renders SftpView for sftp-kind tabs, VaultView for vault-kind, TerminalPane otherwise. */
export function TerminalView() {
  const { tabs, activeTabId } = useSessionStore()
  const { terminalTheme } = useSettingsStore()
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const isWide = activeTab?.kind === 'sftp' || activeTab?.kind === 'vault'

  // 与 TerminalPane 相同的解析：'default' 主题跟随应用深浅色
  const resolvedAppTheme = useResolvedTheme()
  const themeMeta = getTerminalThemeMeta(resolveTerminalThemeId(terminalTheme, resolvedAppTheme))
  const termBg = themeMeta.theme.background
  // The outer boundary follows the application chrome rather than the terminal
  // palette, so light terminal themes remain distinct from the surrounding UI.
  const termBorder = 'var(--surface-border)'

  return (
    <div
      className={`term-wrap ${isWide ? 'sftp-aware' : ''}`}
      style={{
        '--term-bg': termBg,
        '--term-border': termBorder,
      } as CSSProperties}
    >
      <div className="flex-1 relative overflow-hidden">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          if (tab.kind === 'sftp') {
            return (
              <div
                key={tab.id}
                className={`absolute inset-0 ${active ? 'block' : 'hidden'}`}
              >
                <Suspense fallback={<div className="h-full bg-[var(--bg)]" />}>
                  <SftpView />
                </Suspense>
              </div>
            )
          }
          if (tab.kind === 'vault') {
            return (
              <div
                key={tab.id}
                className={`absolute inset-0 ${active ? 'block' : 'hidden'}`}
              >
                <Suspense fallback={<div className="h-full bg-[var(--bg)]" />}>
                  <VaultView />
                </Suspense>
              </div>
            )
          }
          return (
            <div
              key={tab.id}
              className={`absolute inset-0 ${active ? 'block' : 'hidden'}`}
            >
              <Suspense fallback={<div className="h-full bg-[var(--term-bg)]" />}>
                <TerminalPane tab={tab} isActive={active} />
              </Suspense>
            </div>
          )
        })}
      </div>
    </div>
  )
}
