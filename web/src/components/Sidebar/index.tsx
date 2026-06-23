import { useState } from 'react'
import { Plus, Search, Server, MoreVertical, Trash2, Edit } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { ProfileForm } from '@/components/ProfileForm'
import { useProfileStore } from '@/store/profile'
import { useSessionStore } from '@/store/session'
import type { Profile } from '@/types/profile'

export function Sidebar() {
  const {
    profiles: rawProfiles,
    groups: rawGroups,
    selectedGroupId,
    searchQuery,
    loading,
    setSelectedGroup,
    setSearchQuery,
    deleteProfile,
  } = useProfileStore()

  const profiles = rawProfiles ?? []
  const groups = rawGroups ?? []

  const { openTab } = useSessionStore()

  const [showForm, setShowForm] = useState(false)
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    profile: Profile
  } | null>(null)

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

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-sm font-semibold">SSHX</h1>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setEditingProfile(null)
              setShowForm(true)
            }}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索连接..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
      </div>

      {/* Group filter */}
      <div className="px-3 py-2 flex gap-1 flex-wrap">
        <Badge
          variant={selectedGroupId === null ? 'default' : 'outline'}
          className="cursor-pointer"
          onClick={() => setSelectedGroup(null)}
        >
          全部
        </Badge>
        {groups.map((group) => (
          <Badge
            key={group.id}
            variant={selectedGroupId === group.id ? 'default' : 'outline'}
            className="cursor-pointer"
            onClick={() => setSelectedGroup(group.id)}
          >
            {group.icon} {group.name}
          </Badge>
        ))}
      </div>

      <Separator />

      {/* Profile list */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {loading ? (
            <div className="text-center text-muted-foreground text-sm py-8">
              加载中...
            </div>
          ) : profiles.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-8">
              {searchQuery ? '没有匹配的连接' : '暂无连接，点击 + 创建'}
            </div>
          ) : (
            profiles.map((profile) => (
              <div
                key={profile.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent cursor-pointer group"
                onDoubleClick={() => handleConnect(profile)}
                onContextMenu={(e) => handleContextMenu(e, profile)}
              >
                <Server className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{profile.name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {profile.username}@{profile.host}:{profile.port}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleContextMenu(e, profile)
                  }}
                >
                  <MoreVertical className="h-3 w-3" />
                </Button>
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      {/* Context menu */}
      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setContextMenu(null)}
          />
          <div
            className="fixed z-50 bg-background border border-border rounded-md shadow-md py-1 min-w-[160px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent flex items-center gap-2"
              onClick={() => handleConnect(contextMenu.profile)}
            >
              <Server className="h-4 w-4" />
              连接
            </button>
            <button
              className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent flex items-center gap-2"
              onClick={() => handleEdit(contextMenu.profile)}
            >
              <Edit className="h-4 w-4" />
              编辑
            </button>
            <Separator />
            <button
              className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent text-destructive flex items-center gap-2"
              onClick={() => handleDelete(contextMenu.profile)}
            >
              <Trash2 className="h-4 w-4" />
              删除
            </button>
          </div>
        </>
      )}

      {/* Profile form dialog */}
      <ProfileForm
        open={showForm}
        onOpenChange={setShowForm}
        profile={editingProfile}
      />
    </div>
  )
}
