import { invokeCommand } from '@/api/tauri'
import { addPluginListener, type PluginListener } from '@tauri-apps/api/core'
import { getPlatformCapabilities, isMobileRuntime } from './platform'

export interface LifecycleSnapshot {
  generation: number
  networkGeneration: number
  networkState: 'online' | 'offline' | 'unknown'
  state: 'foreground' | 'background' | 'suspended'
  backgroundSince?: number
  deadline?: number
  remainingSeconds: number
  backgroundElapsedSeconds: number
  expired: boolean
  activeSessions: number
  lastReason: string
}

export interface AppDiagnostics extends LifecycleSnapshot {
  platform: string
  androidForegroundService?: boolean
  notificationPermission?: boolean
  iosBackgroundTimeRemainingSeconds?: number
  recentReason: string
}

let installed = false
let lastPhase: 'foreground' | 'background' | undefined
let nativeListeners: PluginListener[] = []

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
  const network = () => {
    void invokeCommand<LifecycleSnapshot>('app_network_update', { online: navigator.onLine })
  }

  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('pagehide', pageHide)
  window.addEventListener('pageshow', pageShow)
  window.addEventListener('online', network)
  window.addEventListener('offline', network)
  const capabilities = getPlatformCapabilities()
  const nativeEvent = capabilities.platform === 'android' ? 'disconnect-all' : 'expired'
  void addPluginListener('session-keepalive', nativeEvent, () => {
    const command = capabilities.platform === 'android'
      ? 'app_disconnect_all_sessions'
      : 'app_background_expired'
    void invokeCommand(command)
  }).then((listener) => { nativeListeners.push(listener) }).catch(() => undefined)
  void addPluginListener<{ online: boolean; generation: number }>('session-keepalive', 'network-change', (event) => {
    void invokeCommand<LifecycleSnapshot>('app_network_update', {
      online: event.online,
      generation: event.generation,
    })
  }).then((listener) => { nativeListeners.push(listener) }).catch(() => undefined)
  if (capabilities.platform === 'android') {
    void addPluginListener<{ message: string }>('session-keepalive', 'notification-limited', (event) => {
      window.dispatchEvent(new CustomEvent('eizhu:notification-limited', { detail: event.message }))
    }).then((listener) => { nativeListeners.push(listener) }).catch(() => undefined)
  }
  visibility()
  network()

  return () => {
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('pagehide', pageHide)
    window.removeEventListener('pageshow', pageShow)
    window.removeEventListener('online', network)
    window.removeEventListener('offline', network)
    for (const listener of nativeListeners) void listener.unregister()
    nativeListeners = []
    installed = false
    lastPhase = undefined
  }
}

export function getLifecycleStatus(): Promise<LifecycleSnapshot> {
  return invokeCommand<LifecycleSnapshot>('app_lifecycle_status')
}

export function getAppDiagnostics(): Promise<AppDiagnostics> {
  return invokeCommand<AppDiagnostics>('app_diagnostics')
}
