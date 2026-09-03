import { useEffect, useRef } from 'react'
import { X, Plus } from 'lucide-react'
import { resolveServerIcon } from '@/lib/serverIcons'
import { useSftpStore } from './storeContext'
import { dropPayloadAttr } from '@/lib/dragRegistry'
import { type PaneSide, type SftpDropTarget, type SftpTab } from '@/store/sftp'

interface PaneTabsProps {
  pane: PaneSide
  onPickServer: () => void
}

/** Multi-server tab strip. Both panes are symmetric: each tab is one
 *  connected server (the left pane starts with the local machine). The
 *  "+" opens the server picker to add another connection to this pane. */
export function PaneTabs({ pane, onPickServer }: PaneTabsProps) {
  const store = useSftpStore()
  const tabs = pane === 'left' ? store.leftTabs : store.rightTabs
  const activeId = pane === 'left' ? store.activeLeftTabId : store.activeRightTabId

  const makeTarget = (tab: SftpTab): SftpDropTarget | null =>
    tab.sessionId
      ? {
          pane,
          tabId: tab.id,
          sessionId: tab.sessionId,
          destDir: tab.path,
          serverName: tab.server.name,
          kind: 'tab',
        }
      : null

  // 悬停弹簧激活（P3）：拖拽期间 dropTarget 停留在未激活标签上 500ms
  // 即自动切换（由 store 的 dropTarget 驱动，替代原 HTML5 onDragOver 定时器）
  const springRef = useRef<string | null>(null)
  useEffect(() => {
    const target = store.dropTarget
    const hoveredTabId = target?.pane === pane && target.kind === 'tab' ? target.tabId : null
    if (!hoveredTabId) {
      springRef.current = null
      return
    }
    if (springRef.current === hoveredTabId) return
    springRef.current = hoveredTabId
    if (hoveredTabId === activeId) return
    const timer = setTimeout(() => store.setActiveTab(pane, hoveredTabId), 500)
    return () => clearTimeout(timer)
  }, [store.dropTarget, pane, activeId, store])

  return (
    <div className="sftp-pane-hdr">
      <div className="sftp-tabs">
        {tabs.map((tab: SftpTab) => {
          const active = tab.id === activeId
          const dropTarget = store.dropTarget?.tabId === tab.id && store.dropTarget.kind === 'tab'
          const Icon = resolveServerIcon('server')
          const target = makeTarget(tab)
          return (
            <div
              key={tab.id}
              className={`sftp-ptab ${active ? 'active' : ''} ${dropTarget ? 'drop-target' : ''}`}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => store.setActiveTab(pane, tab.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  store.setActiveTab(pane, tab.id)
                }
              }}
              title={`${tab.server.name} — ${tab.server.username}@${tab.server.host}${tab.server.port ? ':' + tab.server.port : ''}`}
              data-drag-payload={target ? dropPayloadAttr({ kind: 'sftp', target }) : undefined}
            >
              <Icon size={12} className="sftp-ptab-icon" />
              <span className="sftp-ptab-name">{tab.server.name}</span>
              <button
                className="sftp-ptab-x"
                aria-label={`断开 ${tab.server.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  store.closeTab(pane, tab.id)
                }}
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
        <button
          className="sftp-ptab-add"
          title="连接新服务器"
          aria-label="连接新服务器"
          onClick={onPickServer}
        >
          <Plus size={13} />
        </button>
      </div>
    </div>
  )
}
