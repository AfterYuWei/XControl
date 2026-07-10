import type { CSSProperties } from 'react'
import { useSessionStore } from '@/store/session'
import { useSettingsStore } from '@/store/settings'
import { TerminalPane } from './TerminalPane'
import { SftpView } from '@/components/Sftp/SftpView'
import { VaultView } from '@/components/Vault/VaultView'
import { getTerminalThemeMeta } from '@/lib/terminalThemes'

/** Content router: renders SftpView for sftp-kind tabs, VaultView for vault-kind, TerminalPane otherwise. */
export function TerminalView() {
  const { tabs, activeTabId } = useSessionStore()
  const { terminalTheme } = useSettingsStore()
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const isWide = activeTab?.kind === 'sftp' || activeTab?.kind === 'vault'

  const themeMeta = getTerminalThemeMeta(terminalTheme)
  const termBg = themeMeta.theme.background
  // 沉浸式：边框颜色与终端背景严格一致，消除“边框与终端背景色不一致”的视觉割裂；
  // 内阴影改为极轻量的中性外阴影，仅在卡片外部提供层次，不在终端内部产生异色描边。
  const termBorder = termBg
  const termShadow = '0 1px 2px rgba(0, 0, 0, 0.12)'

  return (
    <div
      className={`term-wrap ${isWide ? 'sftp-aware' : ''}`}
      style={{
        '--term-bg': termBg,
        '--term-border': termBorder,
        '--term-shadow': termShadow,
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
                <SftpView />
              </div>
            )
          }
          if (tab.kind === 'vault') {
            return (
              <div
                key={tab.id}
                className={`absolute inset-0 ${active ? 'block' : 'hidden'}`}
              >
                <VaultView />
              </div>
            )
          }
          return (
            <div
              key={tab.id}
              className={`absolute inset-0 ${active ? 'block' : 'hidden'}`}
            >
              <TerminalPane tab={tab} isActive={active} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
