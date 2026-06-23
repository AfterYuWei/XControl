import { api } from './client'
import type { Group, GroupCreateRequest, GroupUpdateRequest } from '@/types/group'

export const groupApi = {
  list: () => api.get<Group[]>('/api/groups'),

  create: (data: GroupCreateRequest) =>
    api.post<Group>('/api/groups', data),

  update: (id: string, data: GroupUpdateRequest) =>
    api.put<Group>(`/api/groups/${id}`, data),

  delete: (id: string) => api.delete<void>(`/api/groups/${id}`),
}
