import { useRef } from 'react'
import { X, Plus } from 'lucide-react'
import { resolveServerIcon } from '@/lib/serverIcons'
import { useSftpStore } from './storeContext'
import { dropAction, validateDrop, type PaneSide, type SftpDropTarget, type SftpTab } from '@/store/sftp'

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
  const hoverRef = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null)

  return (
    <div className="sftp-pane-hdr">
      <div className="sftp-tabs">
        {tabs.map((tab: SftpTab) => {
          const active = tab.id === activeId
          const dropTarget = store.dropTarget?.tabId === tab.id && store.dropTarget.kind === 'tab'
          const Icon = resolveServerIcon('server')
          const makeTarget = (): SftpDropTarget | null => tab.sessionId ? {
            pane, tabId: tab.id, sessionId: tab.sessionId, destDir: tab.path,
            serverName: tab.server.name, kind: 'tab',
          } : null
          return (
            <div
              key={tab.id}
              className={`sftp-ptab ${active ? 'active' : ''} ${dropTarget ? 'drop-target' : ''}`}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => store.setActiveTab(pane, tab.id)}
              onDragOver={(e) => {
                const target = makeTarget()
                if (!store.dragSession || !target) return
                e.preventDefault()
                e.stopPropagation()
                const copy = e.ctrlKey || e.altKey
                const invalid = validateDrop(store.dragSession, target, copy)
                e.dataTransfer.dropEffect = invalid ? 'none' : dropAction(store.dragSession, target, copy)
                store.setDropTarget(invalid ? null : { ...target, copyModifier: copy })
                if (!active && hoverRef.current?.id !== tab.id) {
                  if (hoverRef.current) clearTimeout(hoverRef.current.timer)
                  hoverRef.current = {
                    id: tab.id,
                    timer: setTimeout(() => store.setActiveTab(pane, tab.id), 500),
                  }
                }
              }}
              onDragLeave={() => {
                if (hoverRef.current?.id === tab.id) clearTimeout(hoverRef.current.timer)
                hoverRef.current = null
              }}
              onDrop={async (e) => {
                const target = makeTarget()
                if (!store.dragSession || !target) return
                e.preventDefault()
                e.stopPropagation()
                if (hoverRef.current) clearTimeout(hoverRef.current.timer)
                store.setDropTarget(target)
                await store.commitDrop(e.ctrlKey || e.altKey)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  store.setActiveTab(pane, tab.id)
                }
              }}
              title={`${tab.server.name} — ${tab.server.username}@${tab.server.host}${tab.server.port ? ':' + tab.server.port : ''}`}
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
