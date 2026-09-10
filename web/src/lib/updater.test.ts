import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadEvent } from '@tauri-apps/plugin-updater'

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  invoke: vi.fn(),
  getVersion: vi.fn(),
  relaunch: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: mocks.getVersion }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('./desktop', () => ({ isTauri: () => true }))
vi.mock('./platform', () => ({ isDesktopRuntime: () => true }))

import { checkForUpdates, downloadAndInstallUpdate } from './updater'

beforeEach(() => {
  mocks.check.mockReset()
  mocks.invoke.mockReset().mockResolvedValue('windows')
  mocks.getVersion.mockReset().mockResolvedValue('0.0.0-test.10.1.shaabcdef')
  mocks.relaunch.mockReset().mockResolvedValue(undefined)
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

  it('下载时回传大小、百分比、实时速度与安装阶段', async () => {
    const now = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(3_000)
    const downloadAndInstall = vi.fn(async (onEvent?: (event: DownloadEvent) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 1_000 } })
      onEvent?.({ event: 'Progress', data: { chunkLength: 250 } })
      onEvent?.({ event: 'Progress', data: { chunkLength: 250 } })
      onEvent?.({ event: 'Finished' })
    })
    mocks.check.mockResolvedValue({ available: true, downloadAndInstall })
    const onProgress = vi.fn()

    await downloadAndInstallUpdate('test', onProgress)

    expect(onProgress).toHaveBeenNthCalledWith(2, {
      phase: 'downloading',
      downloadedBytes: 250,
      totalBytes: 1_000,
      percent: 25,
      bytesPerSecond: 250,
    })
    expect(onProgress).toHaveBeenLastCalledWith({
      phase: 'installing',
      downloadedBytes: 500,
      totalBytes: 1_000,
      percent: 100,
      bytesPerSecond: 0,
    })
    expect(mocks.relaunch).toHaveBeenCalledOnce()
    now.mockRestore()
  })
})
