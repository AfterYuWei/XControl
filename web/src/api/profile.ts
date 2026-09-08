import { invokeCommand } from './tauri'
import type { Profile, ProfileCreateRequest, ProfileTestResult, ProfileUpdateRequest } from '@/types/profile'

export const profileApi = {
  list: (params?: { group_id?: string; search?: string }) =>
    invokeCommand<Profile[]>('profile_list', {
      groupId: params?.group_id ?? null,
      search: params?.search ?? null,
    }),

  get: (id: string) => invokeCommand<Profile>('profile_get', { id }),

  create: (data: ProfileCreateRequest) =>
    invokeCommand<Profile>('profile_create', { request: data }),

  update: (id: string, data: ProfileUpdateRequest) =>
    invokeCommand<Profile>('profile_update', { id, request: data }),

  delete: (id: string) => invokeCommand<void>('profile_delete', { id }),

  testNew: (data: ProfileCreateRequest) =>
    invokeCommand<ProfileTestResult>('profile_test_new', { request: data }),

  test: (id: string, data: ProfileUpdateRequest = {}) =>
    invokeCommand<ProfileTestResult>('profile_test_existing', { id, request: data }),

  confirmHostKey: (id: string, fingerprint: string) =>
    invokeCommand<{ ok: boolean; fingerprint: string }>('profile_confirm_host_key', { id, fingerprint }),
}
