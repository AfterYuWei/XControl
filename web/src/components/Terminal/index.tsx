import { useSessionStore } from '@/store/session'
import { TerminalPane } from './TerminalPane'
import { SftpView } from '@/components/Sftp/SftpView'

interface TerminalViewProps {
  panelOpen: boolean
}

/** Content router: renders SftpView for sftp-kind tabs, TerminalPane otherwise. */
export function TerminalView({ panelOpen }: TerminalViewProps) {
  const { tabs, activeTabId } = useSessionStore()
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const isSftp = activeTab?.kind === 'sftp'

  return (
    <div className={`term-wrap ${isSftp ? 'sftp-aware' : ''}`}>
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
      {/* panelOpen is consumed via CSS sibling selector: when .sshx-panel.open
          is present, .term-wrap gets extra right margin. Kept as prop to allow
          future conditional rendering. */}
      {panelOpen ? null : null}
    </div>
  )
}
