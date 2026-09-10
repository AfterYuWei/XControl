import { invokeCommand } from '@/api/tauri'
import { addPluginListener, type PluginListener } from '@tauri-apps/api/core'
import { getPlatformCapabilities, isMobileRuntime } from './platform'

export interface LifecycleSnapshot {
  generation: number
  state: 'foreground' | 'background' | 'suspended'
  backgroundSince?: number
  deadline?: number
  remainingSeconds: number
  expired: boolean
  activeSessions: number
}

let installed = false
let lastPhase: 'foreground' | 'background' | undefined
let nativeListener: PluginListener | undefined

async function update(phase: 'foreground' | 'background'): Promise<void> {
  if (phase === lastPhase) return
  lastPhase = phase
  try {
    await invokeCommand<LifecycleSnapshot>('app_lifecycle_update', { phase })
  } catch {
    // Lifecycle delivery is retried by the next visibility/pageshow event.
    lastPhase = undefined
  }
}

/** Bind WebView lifecycle events after the platform handshake has completed. */
export function installMobileLifecycle(): () => void {
  if (installed || !isMobileRuntime()) return () => undefined
  installed = true

  const visibility = () => {
    void update(document.visibilityState === 'hidden' ? 'background' : 'foreground')
  }
  const pageHide = () => void update('background')
  const pageShow = () => void update('foreground')

  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('pagehide', pageHide)
  window.addEventListener('pageshow', pageShow)
  const capabilities = getPlatformCapabilities()
  const nativeEvent = capabilities.platform === 'android' ? 'disconnect-all' : 'expired'
  void addPluginListener('session-keepalive', nativeEvent, () => {
    const command = capabilities.platform === 'android'
      ? 'app_disconnect_all_sessions'
      : 'app_background_expired'
    void invokeCommand(command)
  }).then((listener) => {
    nativeListener = listener
  }).catch(() => undefined)
  visibility()

  return () => {
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('pagehide', pageHide)
    window.removeEventListener('pageshow', pageShow)
    void nativeListener?.unregister()
    nativeListener = undefined
    installed = false
    lastPhase = undefined
  }
}

export function getLifecycleStatus(): Promise<LifecycleSnapshot> {
  return invokeCommand<LifecycleSnapshot>('app_lifecycle_status')
}
