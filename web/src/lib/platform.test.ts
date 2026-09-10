// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  getPlatformCapabilities,
  hasTauriRuntime,
  initializePlatform,
  isDesktopRuntime,
  isMobileRuntime,
} from './platform'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('platform capabilities', () => {
  it('uses a safe browser fallback', async () => {
    expect(hasTauriRuntime()).toBe(false)
    await expect(initializePlatform()).resolves.toMatchObject({ runtime: 'browser' })
    expect(isDesktopRuntime()).toBe(false)
    expect(isMobileRuntime()).toBe(false)
  })

  it('does not treat a mobile Tauri runtime as desktop', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    mockedInvoke.mockResolvedValue({
      platform: 'android',
      runtime: 'mobile',
      windowControls: false,
      appUpdates: false,
      dragOut: false,
      nativeFilePaths: false,
      documentPicker: false,
      secureKeyStore: false,
      biometric: false,
      backgroundMode: 'unsupported',
      maxConcurrentTransfers: 2,
    })

    await initializePlatform()

    expect(mockedInvoke).toHaveBeenCalledWith('platform_capabilities')
    expect(getPlatformCapabilities().platform).toBe('android')
    expect(isMobileRuntime()).toBe(true)
    expect(isDesktopRuntime()).toBe(false)
  })
})
