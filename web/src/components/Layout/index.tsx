import { useEffect, useState } from 'react'
import { Sidebar } from '@/components/Sidebar'
import { TerminalView } from '@/components/Terminal'
import { useProfileStore } from '@/store/profile'
import { useSessionStore } from '@/store/session'

export function Layout() {
  const { tabs } = useSessionStore()
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [isResizing, setIsResizing] = useState(false)

  const { fetchProfiles, fetchGroups } = useProfileStore()

  useEffect(() => {
    fetchProfiles()
    fetchGroups()
  }, [fetchProfiles, fetchGroups])

  const handleMouseDown = () => {
    setIsResizing(true)
  }

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return
      const newWidth = Math.max(200, Math.min(400, e.clientX))
      setSidebarWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* Sidebar */}
      <div
        className="flex-shrink-0 border-r border-border overflow-hidden"
        style={{ width: sidebarWidth }}
      >
        <Sidebar />
      </div>

      {/* Resize handle */}
      <div
        className="w-1 cursor-col-resize hover:bg-primary/20 transition-colors flex-shrink-0"
        onMouseDown={handleMouseDown}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {tabs.length === 0 ? (
          <EmptyState />
        ) : (
          <TerminalView />
        )}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center text-muted-foreground">
        <div className="text-6xl mb-4">🖥️</div>
        <h2 className="text-xl font-semibold mb-2">欢迎使用 SSHX</h2>
        <p className="text-sm">
          从左侧选择一个服务器连接，或创建新的连接
        </p>
      </div>
    </div>
  )
}
