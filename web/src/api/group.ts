import { invokeCommand } from './tauri'
import type { Group, GroupCreateRequest, GroupUpdateRequest } from '@/types/group'

export const groupApi = {
  list: () => invokeCommand<Group[]>('group_list'),

  create: (data: GroupCreateRequest) =>
    invokeCommand<Group>('group_create', { request: data }),

  update: (id: string, data: GroupUpdateRequest) =>
    invokeCommand<Group>('group_update', { id, request: data }),

  delete: (id: string) => invokeCommand<void>('group_delete', { id }),
}
