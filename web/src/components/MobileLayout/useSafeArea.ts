import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/** 与插件 SystemInsets 模型对应（camelCase，单位 CSS 像素）。 */
interface SystemInsets {
  top: number
  bottom: number
  left: number
  right: number
}

function apply(insets: SystemInsets) {
  const root = document.documentElement
  root.style.setProperty('--safe-inset-top', `${insets.top}px`)
  root.style.setProperty('--safe-inset-bottom', `${insets.bottom}px`)
  root.style.setProperty('--safe-inset-left', `${insets.left}px`)
  root.style.setProperty('--safe-inset-right', `${insets.right}px`)
}

/**
 * 把系统栏安全区写入 --safe-inset-* CSS 变量。
 * Android WebView（Chromium < 140）的 env(safe-area-inset-*) 恒为 0，
 * 由原生插件提供数值；其余平台 env() 仍作为 CSS 兜底。
 * Android 侧旋转/折叠时会推送 system-insets-changed 事件。
 */
export function useSafeAreaInsets() {
  useEffect(() => {
    let disposed = false
    let unlistenChanged: (() => void) | undefined

    invoke<SystemInsets>('plugin:system-insets|get_system_insets')
      .then((insets) => {
        if (!disposed) apply(insets)
      })
      .catch(() => {})

    listen<SystemInsets>('system-insets-changed', (event) => apply(event.payload))
      .then((unlisten) => {
        if (disposed) unlisten()
        else unlistenChanged = unlisten
      })
      .catch(() => {})

    return () => {
      disposed = true
      unlistenChanged?.()
    }
  }, [])
}
