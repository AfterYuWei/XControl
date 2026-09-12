import { lazy, useEffect, useMemo, useRef, useState, createElement } from 'react'
import { Plus, Search, X, Server } from 'lucide-react'
import { toast } from 'sonner'
import { MobileHeader } from './MobileHeader'
import { MobileEmpty } from './MobileEmpty'
import { HostRow } from './HostRow'
import { MobileSheet } from './MobileSheet'
import { useHeaderCollapse } from './useHeaderCollapse'
import { useProfileStore } from '@/store/profile'
import { useSessionStore } from '@/store/session'
import { resolveGroupIcon } from '@/lib/groupIcons'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { Profile } from '@/types/profile'

const ProfileForm = lazy(() =>
  import('@/components/ProfileForm').then((module) => ({ default: module.ProfileForm })),
)

export function MobileHostList() {
  const {
    profiles: rawProfiles,
    groups: rawGroups,
    searchQuery,
    loading,
    deleteProfile,
    fetchProfiles,
    fetchGroups,
    setSearchQuery,
  } = useProfileStore()
  const { tabs, activeTabId, openTab } = useSessionStore()

  const profiles = useMemo(() => rawProfiles ?? [], [rawProfiles])
  const groups = useMemo(() => rawGroups ?? [], [rawGroups])

  const scrollRef = useRef<HTMLDivElement>(null)
  const collapsed = useHeaderCollapse(scrollRef)

  const [hostQuery, setHostQuery] = useState('')
  const [formProfile, setFormProfile] = useState<Profile | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [sheetProfile, setSheetProfile] = useState<Profile | null>(null)
  const [profileToDelete, setProfileToDelete] = useState<Profile | null>(null)

  useEffect(() => {
    void fetchProfiles()
    void fetchGroups()
  }, [fetchGroups, fetchProfiles])

  // 防抖同步到 store（后端查询）；列表渲染用上面的本地即时过滤
  useEffect(() => {
    if (hostQuery === searchQuery) return
    const timer = window.setTimeout(() => setSearchQuery(hostQuery), 250)
    return () => window.clearTimeout(timer)
  }, [hostQuery, searchQuery, setSearchQuery])

  // 本地即时过滤（skill §1：输入路径零感知延迟）；防抖仅用于同步后端查询
  const visibleProfiles = useMemo(() => {
    const q = hostQuery.trim().toLowerCase()
    if (!q) return profiles
    return profiles.filter((p) =>
      p.name.toLowerCase().includes(q)
      || p.host.toLowerCase().includes(q)
      || p.tags.some((tag) => tag.toLowerCase().includes(q)),
    )
  }, [profiles, hostQuery])

  const serversByGroup = useMemo(() => {
    const map: Record<string, Profile[]> = {}
    groups.forEach((group) => { map[group.id] = [] })
    visibleProfiles.forEach((profile) => {
      if (profile.group_id && map[profile.group_id] !== undefined) map[profile.group_id].push(profile)
    })
    return map
  }, [visibleProfiles, groups])

  const looseServers = useMemo(
    () => visibleProfiles.filter((p) => !p.group_id || !groups.some((g) => g.id === p.group_id)),
    [visibleProfiles, groups],
  )

  const handleConnect = (profile: Profile) => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId)
    const shouldReuseActiveDraft =
      activeTab?.kind === 'terminal' && !activeTab.profileId && !activeTab.sessionId
    void openTab(
      profile.id,
      profile.name,
      profile.host,
      profile.port,
      profile.username,
      shouldReuseActiveDraft ? activeTab.id : undefined,
    )
  }

  const openEditForm = (profile: Profile | null) => {
    setFormProfile(profile)
    setFormOpen(true)
  }

  const confirmDelete = async () => {
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

  const renderRow = (profile: Profile) => {
    const tab = tabs.find((item) => item.profileId === profile.id && item.kind === 'terminal')
    const status = tab?.status ?? 'disconnected'
    return (
      <HostRow
        key={profile.id}
        profile={profile}
        status={status}
        onConnect={() => handleConnect(profile)}
        onEdit={() => openEditForm(profile)}
        onRequestDelete={() => setProfileToDelete(profile)}
        onLongPress={() => setSheetProfile(profile)}
      />
    )
  }

  const isEmpty = profiles.length === 0 && groups.length === 0

  return (
    <div className="m-page">
      <MobileHeader variant="large" title="主机" collapsed={collapsed} trailing={
        <button
          type="button"
          className="m-round-btn"
          aria-label="新增服务器"
          onClick={() => openEditForm(null)}
        >
          <Plus size={18} />
        </button>
      } />
      <div className="m-page-scroll" ref={scrollRef}>
        <div className="m-page-body">
          <label className="m-search">
            <Search aria-hidden="true" />
            <input
              type="search"
              value={hostQuery}
              placeholder="搜索名称、地址或标签"
              aria-label="搜索主机"
              onChange={(event) => setHostQuery(event.target.value)}
            />
            {hostQuery && (
              <button type="button" className="m-search-clear" aria-label="清除搜索" onClick={() => setHostQuery('')}>
                <X size={14} />
              </button>
            )}
          </label>

          {loading && profiles.length === 0 && groups.length === 0 ? (
            <div className="m-loading">加载中…</div>
          ) : isEmpty ? (
            <MobileEmpty
              icon={Server}
              title="暂无连接"
              description="添加一台服务器开始连接。"
              action={(
                <button type="button" className="m-empty-action" onClick={() => openEditForm(null)}>
                  新建服务器
                </button>
              )}
            />
          ) : visibleProfiles.length === 0 ? (
            <MobileEmpty
              icon={Search}
              title="未找到相关服务器"
              description="试试其他名称、地址或标签。"
            />
          ) : (
            <>
              {groups.map((group) => {
                const list = serversByGroup[group.id] ?? []
                if (list.length === 0 && hostQuery) return null
                return (
                  <section key={group.id}>
                    <h2 className="m-eyebrow">
                      {createElement(resolveGroupIcon(group.icon), { size: 12, 'aria-hidden': true })}
                      <span>{group.name}</span>
                      <span className="m-eyebrow-count">{list.length}</span>
                    </h2>
                    <div className="m-card">{list.map(renderRow)}</div>
                  </section>
                )
              })}
              {looseServers.length > 0 && (
                <section>
                  {groups.length > 0 && (
                    <h2 className="m-eyebrow">
                      <span>未分组</span>
                      <span className="m-eyebrow-count">{looseServers.length}</span>
                    </h2>
                  )}
                  <div className="m-card">{looseServers.map(renderRow)}</div>
                </section>
              )}
            </>
          )}
        </div>
      </div>

      <MobileSheet
        open={sheetProfile !== null}
        onOpenChange={(open) => { if (!open) setSheetProfile(null) }}
        title={sheetProfile?.name}
        items={sheetProfile ? [
          { id: 'connect', label: '连接', onSelect: () => handleConnect(sheetProfile) },
          { id: 'edit', label: '编辑', onSelect: () => openEditForm(sheetProfile) },
          { id: 'delete', label: '删除', danger: true, onSelect: () => setProfileToDelete(sheetProfile) },
        ] : []}
      />

      <ProfileForm
        key={formOpen ? `profile-${formProfile?.id || 'new'}` : 'profile-closed'}
        open={formOpen}
        onOpenChange={setFormOpen}
        profile={formProfile}
      />

      <AlertDialog open={profileToDelete !== null} onOpenChange={(open) => !open && setProfileToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除连接？</AlertDialogTitle>
            <AlertDialogDescription>确定删除连接「{profileToDelete?.name}」？此操作无法撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void confirmDelete()}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
