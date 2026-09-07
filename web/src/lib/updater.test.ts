import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  invoke: vi.fn(),
  getVersion: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: mocks.getVersion }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('./desktop', () => ({ isTauri: () => true }))

import { checkForUpdates } from './updater'

beforeEach(() => {
  mocks.check.mockReset()
  mocks.invoke.mockReset().mockResolvedValue('windows')
  mocks.getVersion.mockReset().mockResolvedValue('0.0.0-test.10.1.shaabcdef')
  mocks.check.mockResolvedValue({ available: false })
})

describe('desktop updater channels', () => {
  it('测试构建检查测试通道时使用独立 target 且保持单调更新', async () => {
    await checkForUpdates('test')

    expect(mocks.check).toHaveBeenCalledWith({
      target: 'test-windows-x86_64',
      allowDowngrades: false,
    })
  })

  it('显式切换到正式通道时允许跨通道版本转换', async () => {
    await checkForUpdates('stable')

    expect(mocks.check).toHaveBeenCalledWith({
      target: 'stable-windows-x86_64',
      allowDowngrades: true,
    })
  })
})
