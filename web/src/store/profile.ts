import { create } from 'zustand'
import { profileApi } from '@/api/profile'
import { groupApi } from '@/api/group'
import type { Profile, ProfileCreateRequest, ProfileUpdateRequest } from '@/types/profile'
import type { Group } from '@/types/group'

interface ProfileStore {
  profiles: Profile[]
  groups: Group[]
  selectedGroupId: string | null
  searchQuery: string
  loading: boolean
  error: string | null

  // Actions
  fetchProfiles: () => Promise<void>
  fetchGroups: () => Promise<void>
  /** 备份导入等批量变更后，清除筛选并原子刷新服务器与分组。 */
  refreshAll: () => Promise<void>
  /** 使用后端事务提交后返回的数据快照立即更新界面。 */
  applySnapshot: (profiles: Profile[], groups: Group[]) => void
  createProfile: (data: ProfileCreateRequest) => Promise<Profile>
  updateProfile: (id: string, data: ProfileUpdateRequest) => Promise<Profile>
  deleteProfile: (id: string) => Promise<void>
  createGroup: (data: { name: string; parent_id?: string; icon?: string }) => Promise<Group>
  updateGroup: (id: string, data: { name?: string; parent_id?: string; icon?: string }) => Promise<Group>
  deleteGroup: (id: string) => Promise<void>
  setSelectedGroup: (id: string | null) => void
  setSearchQuery: (query: string) => void
}

export const useProfileStore = create<ProfileStore>((set, get) => ({
  profiles: [],
  groups: [],
  selectedGroupId: null,
  searchQuery: '',
  loading: false,
  error: null,

  fetchProfiles: async () => {
    set({ loading: true, error: null })
    try {
      const { selectedGroupId, searchQuery } = get()
      const profiles = await profileApi.list({
        group_id: selectedGroupId || undefined,
        search: searchQuery || undefined,
      })
      set({ profiles: profiles ?? [], loading: false })
    } catch (err) {
      console.error('Failed to fetch profiles:', err)
      set({ error: errorMessage(err), loading: false })
    }
  },

  fetchGroups: async () => {
    try {
      const groups = await groupApi.list()
      set({ groups: groups ?? [] })
    } catch (err) {
      console.error('Failed to fetch groups:', err)
    }
  },

  refreshAll: async () => {
    // 备份中可能包含当前筛选之外的分组和服务器。批量导入完成后回到
    // 全量视图，并在两个请求都成功后一次性更新，避免侧栏短暂显示孤儿记录。
    set({ selectedGroupId: null, searchQuery: '', loading: true, error: null })
    try {
      const [profiles, groups] = await Promise.all([
        profileApi.list(),
        groupApi.list(),
      ])
      set({ profiles: profiles ?? [], groups: groups ?? [], loading: false })
    } catch (err) {
      set({ error: errorMessage(err), loading: false })
      throw err
    }
  },

  applySnapshot: (profiles, groups) => {
    set({
      profiles: profiles ?? [],
      groups: groups ?? [],
      selectedGroupId: null,
      searchQuery: '',
      loading: false,
      error: null,
    })
  },

  createProfile: async (data) => {
    const profile = await profileApi.create(data)
    get().fetchProfiles()
    return profile
  },

  updateProfile: async (id, data) => {
    const profile = await profileApi.update(id, data)
    get().fetchProfiles()
    return profile
  },

  deleteProfile: async (id) => {
    await profileApi.delete(id)
    get().fetchProfiles()
  },

  createGroup: async (data) => {
    const group = await groupApi.create(data)
    get().fetchGroups()
    return group
  },

  updateGroup: async (id, data) => {
    const group = await groupApi.update(id, data)
    get().fetchGroups()
    return group
  },

  deleteGroup: async (id) => {
    await groupApi.delete(id)
    get().fetchGroups()
    get().fetchProfiles()
  },

  setSelectedGroup: (id) => {
    set({ selectedGroupId: id })
    get().fetchProfiles()
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query })
    get().fetchProfiles()
  },
}))

function errorMessage(err: unknown): string {
  const apiMessage = (err as { error?: { message?: string } })?.error?.message
  return apiMessage ?? (err instanceof Error ? err.message : String(err))
}
