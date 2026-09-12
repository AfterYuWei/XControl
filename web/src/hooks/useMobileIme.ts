import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { isMobileRuntime } from '@/lib/platform'

interface SystemInsets {
  ime?: number
}

const GET_INSETS = 'plugin:system-insets|get_system_insets'
/** 低于该高度视为键盘未弹出（过渡动画/误报过滤） */
export const IME_OPEN_THRESHOLD_PX = 60

/**
 * 订阅 Android 原生 IME 高度（CSS 像素）。软键盘弹出/收起都会触发原生
 * insets 重分发，比 visualViewport resize 可靠（adjustPan 下视口不收缩）。
 * 非移动运行时/插件缺失时恒为 0。
 */
export function useImeInset(): number {
  const [ime, setIme] = useState(0)

  useEffect(() => {
    if (!isMobileRuntime()) return
    let disposed = false
    let unlisten: (() => void) | undefined

    invoke<SystemInsets>(GET_INSETS)
      .then((insets) => {
        if (!disposed) setIme(insets.ime ?? 0)
      })
      .catch(() => {})

    void listen<SystemInsets>('system-insets-changed', (event) => {
      if (!disposed) setIme(event.payload.ime ?? 0)
    })
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch(() => {})

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return ime
}
