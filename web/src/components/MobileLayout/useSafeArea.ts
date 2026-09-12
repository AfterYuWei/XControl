import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/** 与插件 SystemInsets 模型对应（camelCase，单位 CSS 像素）。 */
interface SystemInsets {
  top: number
  bottom: number
  left: number
  right: number
  /** 软键盘可见高度（Android 原生 insets，键盘检测/工具栏抬升依据） */
  ime?: number
}

function apply(insets: SystemInsets) {
  const root = document.documentElement
  root.style.setProperty('--safe-inset-top', `${insets.top}px`)
  root.style.setProperty('--safe-inset-bottom', `${insets.bottom}px`)
  root.style.setProperty('--safe-inset-left', `${insets.left}px`)
  root.style.setProperty('--safe-inset-right', `${insets.right}px`)
  root.style.setProperty('--m-keyboard-inset', `${insets.ime ?? 0}px`)
}

const GET_INSETS = 'plugin:system-insets|get_system_insets'

/**
 * 把系统栏安全区写入 --safe-inset-* CSS 变量。
 * Android WebView（Chromium < 140）的 env(safe-area-inset-*) 恒为 0，
 * 由原生插件提供数值；其余平台 env() 仍作为 CSS 兜底。
 *
 * 启动阶段原生层 insets 可能尚未完成首次分发（返回全零），用短轮询重试；
 * 旋转/折叠/回前台时重新拉取，避免依赖插件事件时序。
 */
export function useSafeAreaInsets() {
  useEffect(() => {
    let disposed = false
    const POLL_INTERVAL_MS = 350
    const MAX_POLLS = 8

    const fetchOnce = () => invoke<SystemInsets>(GET_INSETS)

    const poll = (remaining: number) => {
      if (disposed) return
      fetchOnce()
        .then((insets) => {
          if (disposed) return
          apply(insets)
          if (insets.top <= 0 && remaining > 1) {
            setTimeout(() => poll(remaining - 1), POLL_INTERVAL_MS)
          } else if (insets.top <= 0) {
            console.warn('[safe-area] insets 仍为 0，状态栏区域可能重叠')
          }
        })
        .catch((error) => {
          console.warn('[safe-area] get_system_insets 失败:', error)
          if (remaining > 1) setTimeout(() => poll(remaining - 1), POLL_INTERVAL_MS * 2)
        })
    }

    poll(MAX_POLLS)

    const refresh = () => {
      fetchOnce()
        .then((insets) => {
          if (!disposed) apply(insets)
        })
        .catch(() => {})
    }
    window.addEventListener('resize', refresh)
    window.addEventListener('orientationchange', refresh)
    document.addEventListener('visibilitychange', refresh)

    // 软键盘弹出/收起不一定伴随 window resize（adjustPan），原生 insets
    //事件是唯一可靠的键盘实时信号
    let unlisten: (() => void) | undefined
    void listen<SystemInsets>('system-insets-changed', (event) => {
      if (!disposed) apply(event.payload)
    }).then((dispose) => {
      if (disposed) dispose()
      else unlisten = dispose
    })

    return () => {
      disposed = true
      unlisten?.()
      window.removeEventListener('resize', refresh)
      window.removeEventListener('orientationchange', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
}
