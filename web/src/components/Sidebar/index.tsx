import { useState, useMemo } from 'react'
import { Plus, Server, Trash2, Edit } from 'lucide-react'
import { ProfileForm } from '@/components/ProfileForm'
import { useProfileStore } from '@/store/profile'
import { useSessionStore } from '@/store/session'
import type { Profile } from '@/types/profile'

export function Sidebar() {
  const {
    profiles: rawProfiles,
    groups: rawGroups,
    searchQuery,
    loading,
    setSearchQuery,
    deleteProfile,
  } = useProfileStore()

  const profiles = rawProfiles ?? []
  const groups = rawGroups ?? []

  const { openTab, tabs, activeTabId } = useSessionStore()

  const [showForm, setShowForm] = useState(false)
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    profile: Profile
  } | null>(null)

  // Determine which profile is active (has an open tab that is the active tab)
  const activeProfileId = useMemo(() => {
    const tab = tabs.find((t) => t.id === activeTabId)
    return tab?.profileId
  }, [tabs, activeTabId])

  const handleConnect = (profile: Profile) => {
    openTab(profile.id, profile.name, profile.host, profile.port, profile.username)
  }

  const handleEdit = (profile: Profile) => {
    setEditingProfile(profile)
    setShowForm(true)
    setContextMenu(null)
  }

  const handleDelete = async (profile: Profile) => {
    if (confirm(`确定删除连接 "${profile.name}"?`)) {
      await deleteProfile(profile.id)
    }
    setContextMenu(null)
  }

  const handleContextMenu = (e: React.MouseEvent, profile: Profile) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, profile })
  }

  // Group profiles by their group; ungrouped go to "Ungrouped"
  const grouped = useMemo(() => {
    const map: Record<string, Profile[]> = {}
    const orderedGroupNames: string[] = []
    groups.forEach((g) => {
      map[g.id] = []
      orderedGroupNames.push(g.id)
    })
    if (!orderedGroupNames.includes('__ungrouped__')) {
      map['__ungrouped__'] = []
      orderedGroupNames.push('__ungrouped__')
    }
    profiles.forEach((p) => {
      const key = p.group_id && map[p.group_id] !== undefined ? p.group_id : '__ungrouped__'
      if (!map[key]) {
        map[key] = []
        if (!orderedGroupNames.includes(key)) orderedGroupNames.push(key)
      }
      map[key].push(p)
    })
    return { map, orderedGroupNames }
  }, [profiles, groups])

  const groupName = (gid: string) => {
    if (gid === '__ungrouped__') return 'Ungrouped'
    const g = groups.find((gg) => gg.id === gid)
    return g ? `${g.icon || ''} ${g.name}`.trim() : 'Ungrouped'
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header: brand + search */}
      <div className="sidebar-hdr">
        <div className="sidebar-brand">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 5 6.5 8 3 11" />
            <line x1="8" y1="11" x2="13" y2="11" />
          </svg>
          SSH Terminal
          <button
            className="ml-auto"
            style={{
              width: 22,
              height: 22,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'transparent',
              color: 'var(--fg-4)',
              cursor: 'pointer',
              borderRadius: 'var(--r-xs)',
            }}
            onClick={() => {
              setEditingProfile(null)
              setShowForm(true)
            }}
            title="New connection"
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="search-wrap">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="7" cy="7" r="4.5" />
            <line x1="10.2" y1="10.2" x2="14" y2="14" />
          </svg>
          <input
            type="text"
            placeholder="Search servers…"
            autoComplete="off"
            spellCheck={false}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Server list */}
      <div className="sidebar-body">
        {loading ? (
          <div className="sidebar-empty">
            <span>Loading…</span>
          </div>
        ) : profiles.length === 0 ? (
          <div className="sidebar-empty">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
              <circle cx="7" cy="7" r="4.5" />
              <line x1="10.2" y1="10.2" x2="14" y2="14" />
            </svg>
            <span>{searchQuery ? `No servers match "${searchQuery}"` : '暂无连接，点击 + 创建'}</span>
          </div>
        ) : (
          grouped.orderedGroupNames.map((gid) => {
            const list = grouped.map[gid]
            if (!list || list.length === 0) return null
            return (
              <div className="srv-group" key={gid}>
                <div className="grp-label">
                  <span>{groupName(gid)}</span>
                  <span className="grp-cnt">{list.length}</span>
                </div>
                {list.map((profile) => {
                  const isActive = profile.id === activeProfileId
                  // Status: derive from open tabs for this profile
                  const tab = tabs.find((t) => t.profileId === profile.id)
                  const status = tab?.status ?? 'disconnected'
                  const dotClass =
                    status === 'connected' ? 'on' : status === 'connecting' ? 'loading' : 'off'
                  return (
                    <div
                      key={profile.id}
                      className={`srv ${status === 'disconnected' ? 'offline' : ''} ${isActive ? 'active' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`Connect to ${profile.name} (${profile.host}:${profile.port})`}
                      onClick={() => handleConnect(profile)}
                      onDoubleClick={() => handleConnect(profile)}
                      onContextMenu={(e) => handleContextMenu(e, profile)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          handleConnect(profile)
                        }
                      }}
                    >
                      <span className={`dot ${dotClass}`} aria-hidden="true" />
                      <div className="srv-info">
                        <span className="srv-nm">{profile.name}</span>
                        <span className="srv-meta">
                          {profile.username}@{profile.host}:{profile.port}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })
        )}
      </div>

      {/* Footer: kbd hints */}
      <div className="sidebar-ft">
        <div className="kbd-hint">
          <kbd>⌘K</kbd>
        </div>
        <div className="kbd-hint">
          <kbd>⌘B</kbd>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
          <div
            className="fixed z-50"
            style={{
              left: contextMenu.x,
              top: contextMenu.y,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
              padding: '4px',
              minWidth: 160,
            }}
          >
            <button
              className="w-full text-left flex items-center gap-2"
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                color: 'var(--fg-2)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                borderRadius: 'var(--r-xs)',
                fontFamily: 'var(--sans)',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              onClick={() => handleConnect(contextMenu.profile)}
            >
              <Server size={13} />
              连接
            </button>
            <button
              className="w-full text-left flex items-center gap-2"
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                color: 'var(--fg-2)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                borderRadius: 'var(--r-xs)',
                fontFamily: 'var(--sans)',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              onClick={() => handleEdit(contextMenu.profile)}
            >
              <Edit size={13} />
              编辑
            </button>
            <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
            <button
              className="w-full text-left flex items-center gap-2"
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                color: 'var(--red)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                borderRadius: 'var(--r-xs)',
                fontFamily: 'var(--sans)',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--red-bg)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              onClick={() => handleDelete(contextMenu.profile)}
            >
              <Trash2 size={13} />
              删除
            </button>
          </div>
        </>
      )}

      {/* Profile form dialog */}
      <ProfileForm
        key={showForm ? editingProfile?.id || 'new' : 'closed'}
        open={showForm}
        onOpenChange={setShowForm}
        profile={editingProfile}
      />
    </div>
  )
}
