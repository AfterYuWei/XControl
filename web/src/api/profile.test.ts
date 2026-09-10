import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { profileApi } from './profile'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
})

describe('profileApi', () => {
  it('持久化 CRUD 仅通过领域化 Tauri commands', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    await profileApi.list({ group_id: 'g1', search: '生产' })
    expect(mockedInvoke).toHaveBeenLastCalledWith('profile_list', {
      groupId: 'g1',
      search: '生产',
    })

    await profileApi.get('p1')
    expect(mockedInvoke).toHaveBeenLastCalledWith('profile_get', { id: 'p1' })

    const request = {
      name: 'web',
      host: 'example.com',
      username: 'root',
      auth_type: 'password' as const,
      password: 'secret',
    }
    await profileApi.create(request)
    expect(mockedInvoke).toHaveBeenLastCalledWith('profile_create', { request })

    await profileApi.update('p1', { note: '生产' })
    expect(mockedInvoke).toHaveBeenLastCalledWith('profile_update', {
      id: 'p1',
      request: { note: '生产' },
    })

    await profileApi.delete('p1')
    expect(mockedInvoke).toHaveBeenLastCalledWith('profile_delete', { id: 'p1' })
  })

  it('SSH 连接测试与 host-key 确认通过 Rust commands', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const draft = {
      name: 'web',
      host: 'example.com',
      username: 'root',
      auth_type: 'agent' as const,
    }
    await profileApi.testNew(draft)
    expect(mockedInvoke).toHaveBeenLastCalledWith('profile_test_new', { request: draft })

    await profileApi.test('p1', { host: 'new.example.com' })
    expect(mockedInvoke).toHaveBeenLastCalledWith('profile_test_existing', {
      id: 'p1',
      request: { host: 'new.example.com' },
    })

    await profileApi.confirmHostKey('p1', 'SHA256:test')
    expect(mockedInvoke).toHaveBeenLastCalledWith('profile_confirm_host_key', {
      id: 'p1',
      fingerprint: 'SHA256:test',
    })
  })

  it('在纯浏览器环境中返回明确的客户端能力错误', async () => {
    mockedInvoke.mockRejectedValueOnce(
      new TypeError("Cannot read properties of undefined (reading 'invoke')"),
    )

    await expect(
      profileApi.testNew({
        name: 'web',
        host: 'example.com',
        username: 'root',
        auth_type: 'agent',
      }),
    ).rejects.toMatchObject({
      error: {
        code: 'TAURI_UNAVAILABLE',
        message: '此功能需要 eizhu 客户端，请使用 make dev 启动完整开发环境',
      },
    })
  })
})
