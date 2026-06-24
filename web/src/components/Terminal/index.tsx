import { useSessionStore } from '@/store/session'
import { TabBar } from './TabBar'
import { TerminalPane } from './TerminalPane'

interface TerminalViewProps {
  panelOpen: boolean
  onTogglePanel: () => void
}

export function TerminalView({ panelOpen, onTogglePanel }: TerminalViewProps) {
  const { tabs, activeTabId } = useSessionStore()

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <TabBar panelOpen={panelOpen} onTogglePanel={onTogglePanel} />
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
      </div>
    </div>
  )
}
