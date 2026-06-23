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
  createProfile: (data: ProfileCreateRequest) => Promise<Profile>
  updateProfile: (id: string, data: ProfileUpdateRequest) => Promise<Profile>
  deleteProfile: (id: string) => Promise<void>
  createGroup: (data: { name: string; parent_id?: string; icon?: string }) => Promise<Group>
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
      set({ error: (err as Error).message, loading: false })
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
