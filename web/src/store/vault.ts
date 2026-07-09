import { create } from 'zustand'
import { vaultApi } from '@/api/vault'
import { toast } from 'sonner'
import type {
  VaultItem,
  VaultCreateRequest,
  VaultUpdateRequest,
  ProfileRef,
  VaultFilterType,
} from '@/types/vault'

interface VaultStore {
  items: VaultItem[]
  loading: boolean
  error: string | null
  filterType: VaultFilterType
  searchQuery: string

  // Actions
  fetchList: () => Promise<void>
  setFilterType: (t: VaultFilterType) => void
  setSearchQuery: (q: string) => void
  create: (data: VaultCreateRequest) => Promise<VaultItem>
  update: (id: string, data: VaultUpdateRequest) => Promise<VaultItem>
  remove: (id: string) => Promise<void>
  references: (id: string) => Promise<ProfileRef[]>
}

export const useVaultStore = create<VaultStore>((set, get) => ({
  items: [],
  loading: false,
  error: null,
  filterType: 'all',
  searchQuery: '',

  fetchList: async () => {
    set({ loading: true, error: null })
    try {
      const { filterType, searchQuery } = get()
      const items = await vaultApi.list({
        type: filterType === 'all' ? undefined : filterType,
        q: searchQuery || undefined,
      })
      set({ items: items ?? [], loading: false })
    } catch (err) {
      set({ error: (err as Error).message, loading: false })
      toast.error('加载凭据列表失败')
    }
  },

  setFilterType: (t) => {
    set({ filterType: t })
    get().fetchList()
  },

  setSearchQuery: (q) => {
    set({ searchQuery: q })
    get().fetchList()
  },

  create: async (data) => {
    const item = await vaultApi.create(data)
    await get().fetchList()
    toast.success('凭据已创建')
    return item
  },

  update: async (id, data) => {
    const item = await vaultApi.update(id, data)
    await get().fetchList()
    toast.success('凭据已更新')
    return item
  },

  remove: async (id) => {
    await vaultApi.delete(id)
    await get().fetchList()
    toast.success('凭据已删除')
  },

  references: async (id) => {
    const refs = await vaultApi.references(id)
    return refs ?? []
  },
}))
