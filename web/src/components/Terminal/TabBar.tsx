import { X } from 'lucide-react'
import { useSessionStore } from '@/store/session'

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab } = useSessionStore()

  if (tabs.length === 0) return null

  const statusColors = {
    connecting: 'bg-yellow-500',
    connected: 'bg-green-500',
    disconnected: 'bg-red-500',
  }

  return (
    <div className="flex items-center border-b border-border bg-muted/50 overflow-x-auto">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer border-r border-border min-w-[120px] max-w-[200px] ${
            tab.id === activeTabId
              ? 'bg-background text-foreground'
              : 'text-muted-foreground hover:bg-accent'
          }`}
          onClick={() => setActiveTab(tab.id)}
        >
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColors[tab.status]}`} />
          <span className="truncate flex-1">{tab.profileName}</span>
          <button
            className="flex-shrink-0 hover:bg-destructive/20 rounded p-0.5"
            onClick={(e) => {
              e.stopPropagation()
              closeTab(tab.id)
            }}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
