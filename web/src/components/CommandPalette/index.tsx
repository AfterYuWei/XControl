import { useState, useRef, useEffect, useCallback } from 'react'
import { Search, Plus, X as XIcon, PanelLeft, Server, RefreshCw, FolderTree, Copy } from 'lucide-react'
import { useProfileStore } from '@/store/profile'
import { useSessionStore } from '@/store/session'
import { toast } from '@/store/notify'
import type { Profile } from '@/types/profile'

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onToggleSidebar: () => void
}

interface PalItem {
  type: 'srv' | 'cmd'
  sid?: string
  label: string
  status?: Profile['auth_type'] | string
  kbd?: string
  action?: () => void
}

export function CommandPalette({
  open,
  onClose,
  onToggleSidebar,
}: CommandPaletteProps) {
  const { profiles } = useProfileStore()
  const { openTab, tabs, setActiveTab } = useSessionStore()
  const [query, setQuery] = useState('')
  const [selIdx, setSelIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  const profilesList = profiles ?? []

  const buildItems = useCallback((): PalItem[] => {
    const items: PalItem[] = []
    const ql = query.toLowerCase()
    profilesList.forEach((p) => {
      if (ql && !p.name.toLowerCase().includes(ql) && !p.host.includes(ql)) return
      items.push({
        type: 'srv',
        sid: p.id,
        label: `${p.name} — ${p.username}@${p.host}:${p.port}`,
      })
    })
    const cmds: PalItem[] = [
      { type: 'cmd', label: 'New Tab', kbd: '⌘T', action: () => toast('Use the + button to open a new tab') },
      { type: 'cmd', label: 'Close Tab', kbd: '⌘W', action: () => useSessionStore.getState().closeTab(useSessionStore.getState().activeTabId ?? '') },
      { type: 'cmd', label: 'Toggle Sidebar', kbd: '⌘B', action: onToggleSidebar },
      { type: 'cmd', label: 'Reconnect', action: () => toast('Reconnecting…') },
      { type: 'cmd', label: 'Open SFTP', action: () => toast('SFTP browser opened') },
      { type: 'cmd', label: 'Copy SSH Command', action: () => {
        const at = tabs.find((t) => t.id === useSessionStore.getState().activeTabId)
        if (at?.host) toast(`Copied: ssh ${at.username ?? 'root'}@${at.host}`)
      } },
    ]
    cmds.forEach((c) => {
      if (ql && !c.label.toLowerCase().includes(ql)) return
      items.push(c)
    })
    return items
  }, [query, profilesList, tabs, onToggleSidebar])

  const items = buildItems()

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelIdx(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    setSelIdx(0)
  }, [query])

  const exec = (idx: number) => {
    const it = items[idx]
    if (!it) return
    onClose()
    if (it.type === 'srv' && it.sid) {
      const existing = tabs.find((t) => t.profileId === it.sid)
      if (existing) {
        setActiveTab(existing.id)
      } else {
        const p = profilesList.find((pp) => pp.id === it.sid)
        if (p) openTab(p.id, p.name, p.host, p.port, p.username)
      }
    } else if (it.action) {
      it.action()
    }
  }

  if (!open) return null

  let lastType = ''

  return (
    <div
      className={`pal-overlay ${open ? 'open' : ''}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="pal">
        <div className="pal-inp-wrap">
          <Search size={15} />
          <input
            ref={inputRef}
            type="text"
            className="pal-inp"
            placeholder="Command or server name…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelIdx((i) => Math.min(i + 1, items.length - 1))
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelIdx((i) => Math.max(i - 1, 0))
              }
              if (e.key === 'Enter') exec(selIdx)
            }}
          />
        </div>
        <div className="pal-results" ref={resultsRef}>
          {items.length === 0 ? (
            <div className="pal-empty">
              <Search size={18} />
              <span>No commands or servers match "{query}"</span>
            </div>
          ) : (
            items.map((it, i) => {
              const showGroup = it.type !== lastType
              lastType = it.type
              return (
                <div key={i}>
                  {showGroup && (
                    <div className="pal-group">
                      {it.type === 'srv' ? 'Servers' : 'Commands'}
                    </div>
                  )}
                  <div
                    className={`pal-item ${i === selIdx ? 'sel' : ''}`}
                    role="option"
                    aria-selected={i === selIdx}
                    onClick={() => exec(i)}
                    onMouseEnter={() => setSelIdx(i)}
                  >
                    {it.type === 'srv' ? (
                      <>
                        <span className="pal-item-icon">
                          <Server size={14} />
                        </span>
                        <span className="pal-item-label">{it.label}</span>
                      </>
                    ) : (
                      <>
                        <span className="pal-item-icon">
                          {it.label.includes('Sidebar') ? (
                            <PanelLeft size={14} />
                          ) : it.label.includes('Tab') && it.label.includes('New') ? (
                            <Plus size={14} />
                          ) : it.label.includes('Close') ? (
                            <XIcon size={14} />
                          ) : it.label.includes('Reconnect') ? (
                            <RefreshCw size={14} />
                          ) : it.label.includes('SFTP') ? (
                            <FolderTree size={14} />
                          ) : it.label.includes('Copy') ? (
                            <Copy size={14} />
                          ) : (
                            <Server size={14} />
                          )}
                        </span>
                        <span className="pal-item-label">{it.label}</span>
                        {it.kbd && <span className="pal-item-kbd">{it.kbd}</span>}
                      </>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
