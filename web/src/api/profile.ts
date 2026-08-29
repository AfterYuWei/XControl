import { api } from './client'
import type { Profile, ProfileCreateRequest, ProfileTestResult, ProfileUpdateRequest } from '@/types/profile'

export const profileApi = {
  list: (params?: { group_id?: string; search?: string }) => {
    const searchParams = new URLSearchParams()
    if (params?.group_id) searchParams.set('group_id', params.group_id)
    if (params?.search) searchParams.set('search', params.search)
    const query = searchParams.toString()
    return api.get<Profile[]>(`/api/profiles${query ? `?${query}` : ''}`)
  },

  get: (id: string) => api.get<Profile>(`/api/profiles/${id}`),

  create: (data: ProfileCreateRequest) =>
    api.post<Profile>('/api/profiles', data),

  update: (id: string, data: ProfileUpdateRequest) =>
    api.put<Profile>(`/api/profiles/${id}`, data),

  delete: (id: string) => api.delete<void>(`/api/profiles/${id}`),

  testNew: (data: ProfileCreateRequest) =>
    api.post<ProfileTestResult>('/api/profiles/test', data),

  test: (id: string, data: ProfileUpdateRequest = {}) =>
    api.post<ProfileTestResult>(`/api/profiles/${id}/test`, data),

  confirmHostKey: (id: string, fingerprint: string) =>
    api.post<{ ok: boolean; fingerprint: string }>(`/api/profiles/${id}/confirm-hostkey`, { fingerprint }),
}
