import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { groupApi } from './group'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => mockedInvoke.mockReset())

describe('groupApi', () => {
  it('通过领域化 Tauri command 执行 CRUD', async () => {
    mockedInvoke.mockResolvedValueOnce([])
    await expect(groupApi.list()).resolves.toEqual([])
    expect(mockedInvoke).toHaveBeenLastCalledWith('group_list', undefined)

    const request = { name: '生产' }
    mockedInvoke.mockResolvedValueOnce({ id: 'g1', ...request })
    await groupApi.create(request)
    expect(mockedInvoke).toHaveBeenLastCalledWith('group_create', { request })

    mockedInvoke.mockResolvedValueOnce({ id: 'g1', name: '测试' })
    await groupApi.update('g1', { name: '测试' })
    expect(mockedInvoke).toHaveBeenLastCalledWith('group_update', {
      id: 'g1',
      request: { name: '测试' },
    })

    mockedInvoke.mockResolvedValueOnce(undefined)
    await groupApi.delete('g1')
    expect(mockedInvoke).toHaveBeenLastCalledWith('group_delete', { id: 'g1' })
  })
})
