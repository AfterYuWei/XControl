import { invoke } from '@tauri-apps/api/core'

export type NativePlatform = 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'unknown'
export type RuntimeFamily = 'browser' | 'mobile' | 'desktop'
export type BackgroundMode = 'unsupported' | 'android-foreground-service' | 'ios-task-window'

export interface PlatformCapabilities {
  platform: NativePlatform
  runtime: RuntimeFamily
  windowControls: boolean
  appUpdates: boolean
  dragOut: boolean
  nativeFilePaths: boolean
  documentPicker: boolean
  secureKeyStore: boolean
  biometric: boolean
  backgroundMode: BackgroundMode
  maxConcurrentTransfers: number
}

const browserCapabilities: PlatformCapabilities = {
  platform: 'unknown',
  runtime: 'browser',
  windowControls: false,
  appUpdates: false,
  dragOut: false,
  nativeFilePaths: false,
  documentPicker: false,
  secureKeyStore: false,
  biometric: false,
  backgroundMode: 'unsupported',
  maxConcurrentTransfers: 2,
}

let capabilities = browserCapabilities

export function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Load capabilities before React and persisted stores are initialized. */
export async function initializePlatform(): Promise<PlatformCapabilities> {
  if (!hasTauriRuntime()) {
    capabilities = browserCapabilities
    return capabilities
  }
  capabilities = await invoke<PlatformCapabilities>('platform_capabilities')
  return capabilities
}

export function getPlatformCapabilities(): PlatformCapabilities {
  return capabilities
}

export function isDesktopRuntime(): boolean {
  return capabilities.runtime === 'desktop'
}

export function isMobileRuntime(): boolean {
  return capabilities.runtime === 'mobile'
}
