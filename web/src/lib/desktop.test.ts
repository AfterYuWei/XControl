// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
import { invoke } from '@tauri-apps/api/core'

const mockedInvoke = vi.mocked(invoke)

const desktopCapabilities = {
  platform: 'linux', runtime: 'desktop', windowControls: true, appUpdates: true,
  dragOut: true, nativeFilePaths: true, documentPicker: true,
  secureKeyStore: false, biometric: false, backgroundMode: 'unsupported',
  maxConcurrentTransfers: 5,
}

function setTauri(present: boolean) {
  if (present) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
}

beforeEach(() => {
  mockedInvoke.mockReset()
  localStorage.clear()
  setTauri(false)
})

describe('desktop bridge', () => {
  it('浏览器环境不执行桌面初始化', async () => {
    const desktop = await import('./desktop')
    expect(desktop.isTauri()).toBe(false)
    await desktop.initDesktop()
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('Tauri 环境只迁移 Electron 设置', async () => {
    setTauri(true)
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === 'platform_capabilities') return desktopCapabilities
      if (command === 'migrate_electron_settings') {
        return { 'eizhu-settings': '{"state":{"theme":"light"}}' }
      }
      if (command === 'mark_electron_settings_migrated') return undefined
      throw new Error(`unexpected command: ${command}`)
    })
    const platform = await import('./platform')
    await platform.initializePlatform()
    const desktop = await import('./desktop')
    await desktop.initDesktop()

    expect(localStorage.getItem('eizhu-settings')).toContain('light')
    expect(mockedInvoke).toHaveBeenCalledTimes(3)
    expect(mockedInvoke).toHaveBeenNthCalledWith(1, 'platform_capabilities')
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, 'migrate_electron_settings')
    expect(mockedInvoke).toHaveBeenNthCalledWith(3, 'mark_electron_settings_migrated')
  })

  it('设置写入失败时不确认迁移', async () => {
    setTauri(true)
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === 'platform_capabilities') return desktopCapabilities
      return { 'eizhu-settings': '{"state":{}}' }
    })
    const platform = await import('./platform')
    await platform.initializePlatform()
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })
    const desktop = await import('./desktop')
    await desktop.initDesktop()
    expect(mockedInvoke).not.toHaveBeenCalledWith('mark_electron_settings_migrated')
    setItem.mockRestore()
  })
})
