import { useSessionStore } from '@/store/session'
import { TerminalPane } from './TerminalPane'
import { SftpView } from '@/components/Sftp/SftpView'
import { VaultView } from '@/components/Vault/VaultView'

/** Content router: renders SftpView for sftp-kind tabs, VaultView for vault-kind, TerminalPane otherwise. */
export function TerminalView() {
  const { tabs, activeTabId } = useSessionStore()
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const isWide = activeTab?.kind === 'sftp' || activeTab?.kind === 'vault'

  return (
    <div className={`term-wrap ${isWide ? 'sftp-aware' : ''}`}>
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
