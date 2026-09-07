import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  listGroups: vi.fn(),
}))

vi.mock('@/api/profile', () => ({
  profileApi: { list: mocks.listProfiles },
}))

vi.mock('@/api/group', () => ({
  groupApi: { list: mocks.listGroups },
}))

import { useProfileStore } from './profile'

beforeEach(() => {
  mocks.listProfiles.mockReset()
  mocks.listGroups.mockReset()
  useProfileStore.setState({
    profiles: [],
    groups: [],
    selectedGroupId: null,
    searchQuery: '',
    loading: false,
    error: null,
  })
})

describe('profile store refreshAll', () => {
  it('备份导入后清除旧筛选并原子加载全部服务器和分组', async () => {
    const profiles = [{ id: 'profile-1', name: '生产服务器' }]
    const groups = [{ id: 'group-1', name: '生产环境' }]
    useProfileStore.setState({ selectedGroupId: 'old-group', searchQuery: 'old-filter' })
    mocks.listProfiles.mockResolvedValue(profiles)
    mocks.listGroups.mockResolvedValue(groups)

    await useProfileStore.getState().refreshAll()

    expect(mocks.listProfiles).toHaveBeenCalledWith()
    expect(mocks.listGroups).toHaveBeenCalledWith()
    expect(useProfileStore.getState()).toMatchObject({
      profiles,
      groups,
      selectedGroupId: null,
      searchQuery: '',
      loading: false,
      error: null,
    })
  })

  it('刷新失败时保留可展示的后端错误并向调用方抛出', async () => {
    const failure = { error: { code: 'DB_ERROR', message: '读取导入数据失败' } }
    mocks.listProfiles.mockRejectedValue(failure)
    mocks.listGroups.mockResolvedValue([])

    await expect(useProfileStore.getState().refreshAll()).rejects.toBe(failure)

    expect(useProfileStore.getState()).toMatchObject({
      loading: false,
      error: '读取导入数据失败',
    })
  })
})
