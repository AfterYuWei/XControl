import { lazy, Suspense, useState, useMemo, useEffect, useRef } from 'react'
import { Plus, Edit, Trash2, Server, FolderPlus, FolderEdit } from 'lucide-react'
import { ProfileForm } from '@/components/ProfileForm'
import { GroupForm } from '@/components/Sidebar/GroupForm'
import { useProfileStore } from '@/store/profile'
import { useSessionStore } from '@/store/session'
import { useSidebarDetailStore, GLOBAL_PAGE_KEY } from '@/store/sidebarDetail'
import { toast } from 'sonner'
import { resolveServerIcon } from '@/lib/serverIcons'
import { resolveGroupIcon } from '@/lib/groupIcons'
import { usePointerDrag } from '@/hooks/usePointerDrag'
import { dropPayloadAttr } from '@/lib/dragRegistry'
import { isMobileRuntime } from '@/lib/platform'
import { SftpContextMenu } from '@/components/Sftp/SftpContextMenu'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { Profile } from '@/types/profile'
import type { Group } from '@/types/group'

const ServerDetail = lazy(() =>
  import('@/components/ServerDetail').then((module) => ({ default: module.ServerDetail })),
)

const UNGROUPED_ID = '__ungrouped__'

export function Sidebar() {
  const mobile = isMobileRuntime()
  const {
    profiles: rawProfiles,
    groups: rawGroups,
    searchQuery,
    loading,
    deleteProfile,
    deleteGroup,
    updateProfile,
  } = useProfileStore()

  const profiles = useMemo(() => rawProfiles ?? [], [rawProfiles])
  const groups = useMemo(() => rawGroups ?? [], [rawGroups])

  const { openTab, tabs, activeTabId } = useSessionStore()

  // Profile form
  const [showProfileForm, setShowProfileForm] = useState(false)
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null)

  // Group form
  const [showGroupForm, setShowGroupForm] = useState(false)
  const [editingGroup, setEditingGroup] = useState<Group | null>(null)
  const [groupFormParent, setGroupFormParent] = useState<string>('')
  const [profileToDelete, setProfileToDelete] = useState<Profile | null>(null)
  const [groupToDelete, setGroupToDelete] = useState<Group | null>(null)

  // Context menus
  const [profileMenu, setProfileMenu] = useState<{ x: number; y: number; profile: Profile } | null>(null)
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; group: Group } | null>(null)
  const [blankMenu, setBlankMenu] = useState<{ x: number; y: number } | null>(null)

  // Drag-and-drop
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null)

  // ─── 指针拖拽（替代 HTML5 DnD，服务器拖入分组） ──────────────────────────
  const profilesRef = useRef({ profiles, groups })
  useEffect(() => {
    profilesRef.current = { profiles, groups }
  })

  const moveProfileToGroup = async (profileId: string, targetGid: string) => {
    const { profiles: currentProfiles, groups: currentGroups } = profilesRef.current
    const targetGroupId = targetGid === UNGROUPED_ID ? '' : targetGid
    const profile = currentProfiles.find((p) => p.id === profileId)
    if (!profile) return
    if ((profile.group_id || '') === targetGroupId) return // same group, no-op
    try {
      await updateProfile(profileId, { group_id: targetGroupId })
      const label = targetGroupId
        ? currentGroups.find((g) => g.id === targetGroupId)?.name || '分组'
        : '服务器管理'
      toast.success(`已移动到「${label}」`)
    } catch (err) {
      toast.error((err as Error).message || '移动失败')
    }
  }

  const serverDrag = usePointerDrag<{ profileId: string; name: string }>({
    ghostLabel: (session) => session.name,
    onActivate: () => {},
    onOver: (_session, payload) => {
      const groupId = payload?.kind === 'group' ? payload.groupId : null
      setDragOverGroupId((current) => (current === groupId ? current : groupId))
    },
    onDrop: (session, payload) => {
      if (payload.kind !== 'group') return
      setDragOverGroupId(null)
      void moveProfileToGroup(session.profileId, payload.groupId)
    },
    onCancel: () => setDragOverGroupId(null),
  })

  // Click-to-select on the server list (single click selects, double connects).
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)

  // Per-tab page selector + per-tab detail cache (shared across the app).
  const { getPage, setPage, lastTerminalTabId, setLastTerminalTab, clearTab } =
    useSidebarDetailStore()

  // Effective terminal tab for the sidebar: the active terminal tab, or — when
  // an SFTP tab is active — the last terminal tab (sidebar stays unchanged).
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const effectiveTabId = activeTab?.kind === 'terminal'
    ? activeTabId
    : lastTerminalTabId

  // Current page for the effective tab (independent per tab).
  const currentPage = effectiveTabId ? getPage(effectiveTabId) : getPage(GLOBAL_PAGE_KEY)

  // Track the last terminal tab so SFTP tabs freeze the sidebar.
  useEffect(() => {
    if (activeTab?.kind === 'terminal' && activeTabId) {
      setLastTerminalTab(activeTabId)
    }
  }, [activeTab, activeTabId, setLastTerminalTab])

  // Auto-switch to the detail (page 2) when a terminal tab transitions to
  // "connected". Each tab's page is stored independently so other tabs are
  // unaffected.
  const prevStatusRef = useRef<Record<string, string>>({})
  useEffect(() => {
    const prev = prevStatusRef.current
    tabs.forEach((tab) => {
      if (tab.kind !== 'terminal') return
      if (tab.status === 'connected' && prev[tab.id] !== 'connected') {
        setPage(tab.id, 1)
      }
      prev[tab.id] = tab.status
    })
    // prune stale ids
    const currentIds = new Set(tabs.map((t) => t.id))
    Object.keys(prev).forEach((id) => {
      if (!currentIds.has(id)) delete prev[id]
    })
  }, [tabs, setPage])

  // Clean up per-tab cache for closed terminal tabs (release memory).
  const knownTabIdsRef = useRef<Set<string>>(new Set(tabs.map((t) => t.id)))
  useEffect(() => {
    const currentIds = new Set(tabs.map((t) => t.id))
    knownTabIdsRef.current.forEach((id) => {
      if (!currentIds.has(id)) clearTab(id)
    })
    knownTabIdsRef.current = currentIds
  }, [tabs, clearTab])

  // Terminal tabs only — SFTP tabs never get a detail pane.
  const terminalTabs = useMemo(() => tabs.filter((t) => t.kind === 'terminal'), [tabs])

  const activeProfileId = useMemo(() => {
    const tab = tabs.find((t) => t.id === activeTabId)
    return tab?.profileId
  }, [tabs, activeTabId])

  const handleConnect = (profile: Profile) => {
    const shouldReuseActiveDraft =
      activeTab?.kind === 'terminal' &&
      !activeTab.profileId &&
      !activeTab.sessionId

    openTab(
      profile.id,
      profile.name,
      profile.host,
      profile.port,
      profile.username,
      shouldReuseActiveDraft ? activeTab.id : undefined,
    )
  }

  const handleEditProfile = (profile: Profile) => {
    setEditingProfile(profile)
    setShowProfileForm(true)
    setProfileMenu(null)
  }

  const handleDeleteProfile = (profile: Profile) => {
    setProfileToDelete(profile)
    setProfileMenu(null)
  }

  const confirmDeleteProfile = async () => {
    if (!profileToDelete) return
    try {
      await deleteProfile(profileToDelete.id)
      toast.success('连接已删除')
    } catch (err) {
      toast.error((err as Error).message || '删除失败')
    } finally {
      setProfileToDelete(null)
    }
  }

  const handleProfileContextMenu = (e: React.MouseEvent, profile: Profile) => {
    e.preventDefault()
    e.stopPropagation()
    setProfileMenu({ x: e.clientX, y: e.clientY, profile })
  }

  // New servers always default to no group (ungrouped). Grouping is done
  // afterwards via drag-and-drop or manual selection in the form.
  const handleAddServer = () => {
    setEditingProfile(null)
    setShowProfileForm(true)
    setBlankMenu(null)
  }

  // Group CRUD
  const handleAddGroup = (parentId?: string) => {
    setEditingGroup(null)
    setGroupFormParent(parentId ?? '')
    setShowGroupForm(true)
    setGroupMenu(null)
    setBlankMenu(null)
  }

  const handleEditGroup = (group: Group) => {
    setEditingGroup(group)
    setGroupFormParent('')
    setShowGroupForm(true)
    setGroupMenu(null)
  }

  const handleDeleteGroup = (group: Group) => {
    setGroupMenu(null)
    // Front-end guard: backend also enforces 409, but this gives instant UX.
    const count = profiles.filter((p) => p.group_id === group.id).length
    if (count > 0) {
      toast.warning(`该分组下仍有 ${count} 台服务器，请先移动或删除后再删除分组`)
      return
    }
    setGroupToDelete(group)
  }

  const confirmDeleteGroup = async () => {
    if (!groupToDelete) return
    try {
      await deleteGroup(groupToDelete.id)
      toast.success('分组已删除')
    } catch (err) {
      toast.error((err as Error).message || '删除失败')
    } finally {
      setGroupToDelete(null)
    }
  }

  const handleGroupContextMenu = (e: React.MouseEvent, group: Group) => {
    e.preventDefault()
    e.stopPropagation()
    setGroupMenu({ x: e.clientX, y: e.clientY, group })
  }

  // Blank-area context menu (right-click on empty sidebar space).
  const handleBlankContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setBlankMenu({ x: e.clientX, y: e.clientY })
  }

  // 旧 HTML5 分组拖放已被上方指针拖拽（serverDrag）取代

  // Group profiles by their group; ungrouped go to "服务器管理"
  // Split servers into those belonging to a real group vs. loose (no group).
  // Groups render first (folder-like, higher priority); loose servers render
  // last, like files outside any folder.
  const serversByGroup = useMemo(() => {
    const map: Record<string, Profile[]> = {}
    groups.forEach((g) => { map[g.id] = [] })
    profiles.forEach((p) => {
      if (p.group_id && map[p.group_id] !== undefined) map[p.group_id].push(p)
    })
    return map
  }, [profiles, groups])

  const looseServers = useMemo(
    () => profiles.filter((p) => !p.group_id || !groups.some((g) => g.id === p.group_id)),
    [profiles, groups]
  )

  const renderServerRow = (profile: Profile) => {
    const isSelected = profile.id === selectedProfileId
    const isActive = profile.id === activeProfileId
    const tab = tabs.find((t) => t.profileId === profile.id)
    const status = tab?.status ?? 'disconnected'
    const Icon = resolveServerIcon(profile.icon)
    const meta =
      profile.port && profile.port !== 22
        ? `${profile.username}@${profile.host}:${profile.port}`
        : `${profile.username}@${profile.host}`

  return (
    <div
      key={profile.id}
      className={`srv ${status === 'disconnected' ? 'offline' : ''} ${isSelected || isActive ? 'active' : ''}`}
      role="button"
      tabIndex={0}
      onPointerDown={(e) => serverDrag.start(e, { profileId: profile.id, name: profile.name })}
      onClick={(e) => {
        e.stopPropagation()
        if (mobile) handleConnect(profile)
        else setSelectedProfileId(profile.id)
      }}
        onDoubleClick={mobile ? undefined : () => handleConnect(profile)}
        onContextMenu={(e) => handleProfileContextMenu(e, profile)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            handleConnect(profile)
          }
          if (e.key === ' ') {
            e.preventDefault()
            setSelectedProfileId(profile.id)
          }
        }}
      >
        <div className="srv-icon">
          <Icon size={14} />
        </div>
        <div className="srv-info">
          <span className="srv-nm">{profile.name}</span>
          <span className="srv-meta">{meta}</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="srv-edit-btn"
          title="编辑服务器"
          aria-label="编辑服务器"
          onClick={(e) => {
            e.stopPropagation()
            handleEditProfile(profile)
          }}
        >
          <Edit size={12} />
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {currentPage === 0 ? (
        <>
          {/* Page 1 — global server list (shared across all tabs) */}
          <div className="sidebar-title">
            <span className="sidebar-title-left">
              <span className="sidebar-title-text">服务器管理</span>
              <span className="grp-cnt">{profiles.length}</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="grp-add-btn"
              title="新增服务器"
              aria-label="新增服务器"
              onClick={(e) => {
                e.stopPropagation()
                handleAddServer()
              }}
            >
              <Plus size={13} />
            </Button>
          </div>

          <div className="sidebar-body" onContextMenu={handleBlankContextMenu} onClick={() => setSelectedProfileId(null)}>
            {loading ? (
              <div className="sidebar-empty">
                <span>Loading…</span>
              </div>
            ) : profiles.length === 0 && groups.length === 0 ? (
              <div className="sidebar-empty">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
                  <circle cx="7" cy="7" r="4.5" />
                  <line x1="10.2" y1="10.2" x2="14" y2="14" />
                </svg>
                <span>{searchQuery ? `没有匹配 "${searchQuery}" 的服务器` : '暂无连接'}</span>
              </div>
            ) : (
              <>
                {/* Groups (folders) — render first, higher priority than loose servers */}
                {groups.map((grp) => {
                  const list = serversByGroup[grp.id] ?? []
                  if (list.length === 0 && searchQuery) return null
                  const isDropTarget = dragOverGroupId === grp.id
                  const GroupIcon = resolveGroupIcon(grp.icon)

                  return (
                    <div
                      className={`srv-group ${isDropTarget ? 'grp-drop-target' : ''}`}
                      key={grp.id}
                      data-drag-payload={dropPayloadAttr({ kind: 'group', groupId: grp.id })}
                    >
                      <div
                        className="grp-label"
                        onContextMenu={(e) => handleGroupContextMenu(e, grp)}
                      >
                        <span className="grp-label-left">
                          <GroupIcon size={12} className="grp-label-icon" />
                          <span className="grp-label-text">{grp.name}</span>
                          <span className="grp-cnt">{list.length}</span>
                        </span>
                      </div>
                      {list.map(renderServerRow)}
                    </div>
                  )
                })}

                {/* Loose servers (no group) — render last, like files outside folders */}
                {looseServers.length > 0 && (
                  <div
                    className={`srv-group ${dragOverGroupId === UNGROUPED_ID ? 'grp-drop-target' : ''}`}
                    data-drag-payload={dropPayloadAttr({ kind: 'group', groupId: UNGROUPED_ID })}
                  >
                    {groups.length > 0 && (
                      <div className="grp-label">
                        <span className="grp-label-left">
                          <span className="grp-label-text grp-label-muted">未分组</span>
                          <span className="grp-cnt">{looseServers.length}</span>
                        </span>
                      </div>
                    )}
                    {looseServers.map(renderServerRow)}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      ) : (
        /* Page 2 — per-tab detail panes. All terminal-tab panes stay mounted
           (toggled via display:none) so switching tabs never remounts DOM or
           re-requests data. SFTP tabs never receive a pane; when an SFTP tab
           is active the sidebar freezes on the last terminal tab's pane. */
        <div className="sdetail-stack">
          {terminalTabs.length === 0 ? (
            <div className="sidebar-empty">
              <span>暂无服务器会话</span>
            </div>
          ) : (
            terminalTabs.map((tab) => (
              <div
                key={tab.id}
                className="sdetail-slot"
                style={{ display: tab.id === effectiveTabId ? 'flex' : 'none' }}
              >
                <Suspense fallback={null}>
                  <ServerDetail
                  tabId={tab.id}
                  profileId={tab.profileId}
                  profileName={tab.profileName}
                  host={tab.host || '未知'}
                  port={tab.port || 22}
                  username={tab.username || 'root'}
                    active={tab.id === effectiveTabId}
                  />
                </Suspense>
              </div>
            ))
          )}
        </div>
      )}

      {/* Profile context menu */}
      {profileMenu && (
        <SftpContextMenu
          x={profileMenu.x}
          y={profileMenu.y}
          onClose={() => setProfileMenu(null)}
          items={[
            { id: 'connect', label: '连接', icon: <Server size={13} />, onClick: () => handleConnect(profileMenu.profile) },
            { id: 'divider-edit', label: '', divider: true },
            { id: 'edit', label: '编辑', icon: <Edit size={13} />, onClick: () => handleEditProfile(profileMenu.profile) },
            { id: 'divider-delete', label: '', divider: true },
            { id: 'delete', label: '删除', icon: <Trash2 size={13} />, danger: true, onClick: () => void handleDeleteProfile(profileMenu.profile) },
          ]}
        />
      )}

      {/* Group context menu */}
      {groupMenu && (
        <SftpContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          onClose={() => setGroupMenu(null)}
          items={[
            { id: 'add-child', label: '新建子分组', icon: <FolderPlus size={13} />, onClick: () => handleAddGroup(groupMenu.group.id) },
            { id: 'edit', label: '编辑分组', icon: <FolderEdit size={13} />, onClick: () => handleEditGroup(groupMenu.group) },
            { id: 'divider-delete', label: '', divider: true },
            { id: 'delete', label: '删除分组', icon: <Trash2 size={13} />, danger: true, onClick: () => void handleDeleteGroup(groupMenu.group) },
          ]}
        />
      )}

      {/* Blank-area context menu */}
      {blankMenu && (
        <SftpContextMenu
          x={blankMenu.x}
          y={blankMenu.y}
          onClose={() => setBlankMenu(null)}
          items={[
            { id: 'add-server', label: '新建服务器', icon: <Server size={13} />, onClick: handleAddServer },
            { id: 'add-group', label: '新建分组', icon: <FolderPlus size={13} />, onClick: () => handleAddGroup('') },
          ]}
        />
      )}

      {/* Segmented page indicator — page 1 = global list, page 2 = per-tab detail.
          Each segment is a tall transparent hit area wrapping a thin line so
          the visible stroke stays delicate while the click target is generous. */}
      <div className="sidebar-pager">
        <Button
          type="button"
          variant="ghost"
          className={`pager-hit ${currentPage === 0 ? 'active' : ''}`}
          aria-label="第 1 页"
          aria-current={currentPage === 0}
          onClick={() => setPage(effectiveTabId || GLOBAL_PAGE_KEY, 0)}
        >
          <span className="pager-line" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={`pager-hit ${currentPage === 1 ? 'active' : ''}`}
          aria-label="第 2 页"
          aria-current={currentPage === 1}
          onClick={() => setPage(effectiveTabId || GLOBAL_PAGE_KEY, 1)}
        >
          <span className="pager-line" />
        </Button>
      </div>

      {/* Profile form dialog */}
      <ProfileForm
        key={showProfileForm ? `profile-${editingProfile?.id || 'new'}` : 'profile-closed'}
        open={showProfileForm}
        onOpenChange={setShowProfileForm}
        profile={editingProfile}
      />

      {/* Group form dialog */}
      <GroupForm
        key={showGroupForm ? `group-${editingGroup?.id || `new-${groupFormParent}`}` : 'group-closed'}
        open={showGroupForm}
        onOpenChange={setShowGroupForm}
        group={editingGroup}
        defaultParentId={groupFormParent}
      />

      <AlertDialog open={profileToDelete !== null} onOpenChange={(open) => !open && setProfileToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除连接？</AlertDialogTitle>
            <AlertDialogDescription>确定删除连接「{profileToDelete?.name}」？此操作无法撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void confirmDeleteProfile()}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={groupToDelete !== null} onOpenChange={(open) => !open && setGroupToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除分组？</AlertDialogTitle>
            <AlertDialogDescription>确定删除分组「{groupToDelete?.name}」？此操作无法撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void confirmDeleteGroup()}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
