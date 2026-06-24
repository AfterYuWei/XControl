import { useSessionStore } from '@/store/session'
import { TerminalPane } from './TerminalPane'

interface TerminalViewProps {
  panelOpen: boolean
}

export function TerminalView({ panelOpen }: TerminalViewProps) {
  const { tabs, activeTabId } = useSessionStore()

  return (
    <div className="term-wrap">
      <div className="flex-1 relative overflow-hidden">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`absolute inset-0 ${
              tab.id === activeTabId ? 'block' : 'hidden'
            }`}
          >
            <TerminalPane tab={tab} isActive={tab.id === activeTabId} />
          </div>
        ))}
      </div>
      {/* panelOpen is consumed via CSS sibling selector: when .sshx-panel.open
          is present, .term-wrap gets extra right margin. Kept as prop to allow
          future conditional rendering. */}
      {panelOpen ? null : null}
    </div>
  )
}
