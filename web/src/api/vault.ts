import { api, type APIError } from './client'
import type {
  VaultItem,
  VaultCredential,
  VaultCreateRequest,
  VaultUpdateRequest,
  GenerateKeyRequest,
  GenerateKeyResponse,
  ProfileRef,
  VaultType,
} from '@/types/vault'

export interface VaultListParams {
  type?: VaultType
  q?: string
}

export const vaultApi = {
  list: (params?: VaultListParams) => {
    const qs = new URLSearchParams()
    if (params?.type) qs.set('type', params.type)
    if (params?.q) qs.set('q', params.q)
    const query = qs.toString()
    return api.get<VaultItem[]>(`/api/vault${query ? `?${query}` : ''}`)
  },

  get: (id: string) => api.get<VaultItem>(`/api/vault/${id}`),

  create: (data: VaultCreateRequest) =>
    api.post<VaultItem>('/api/vault', data),

  update: (id: string, data: VaultUpdateRequest) =>
    api.put<VaultItem>(`/api/vault/${id}`, data),

  delete: (id: string) => api.delete<void>(`/api/vault/${id}`),

  references: (id: string) => api.get<ProfileRef[]>(`/api/vault/${id}/references`),

  reveal: (id: string) => api.get<VaultCredential>(`/api/vault/${id}/reveal`),

  generateKeyPair: (data: GenerateKeyRequest) =>
    api.post<GenerateKeyResponse>('/api/vault/generate', data),
}

export type { APIError }
