import { useSessionStore } from '@/store/session'
import { TabBar } from './TabBar'
import { TerminalPane } from './TerminalPane'

export function TerminalView() {
  const { tabs, activeTabId } = useSessionStore()

  return (
    <div className="flex flex-col h-full">
      <TabBar />
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
  )
}
