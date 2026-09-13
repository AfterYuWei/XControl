import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

import { isMobileRuntime } from '@/lib/platform'
import { isMobileKeyboardOpen } from '@/lib/mobileViewport'

interface SystemInsets {
  ime?: number
}

const GET_INSETS = 'plugin:system-insets|get_system_insets'
const IME_POLL_INTERVAL_MS = 100
/** 低于该高度视为键盘未弹出（过渡动画/误报过滤） */
export const IME_OPEN_THRESHOLD_PX = 60

let latestIme = 0
let pollTimer: ReturnType<typeof setInterval> | undefined
let pollPending = false
const subscribers = new Set<(ime: number) => void>()

async function pollImeInset() {
  if (pollPending) return
  pollPending = true
  try {
    const insets = await invoke<SystemInsets>(GET_INSETS)
    const next = insets.ime ?? 0
    if (next === latestIme) return
    latestIme = next
    subscribers.forEach((subscriber) => subscriber(next))
  } catch {
    // 原生插件不可用时保持 0，键盘状态继续使用 visualViewport 兜底。
  } finally {
    pollPending = false
  }
}

function startImePolling() {
  if (pollTimer !== undefined) return
  void pollImeInset()
  pollTimer = setInterval(() => void pollImeInset(), IME_POLL_INTERVAL_MS)
}

function stopImePollingIfIdle() {
  if (subscribers.size > 0 || pollTimer === undefined) return
  clearInterval(pollTimer)
  pollTimer = undefined
  pollPending = false
}

/**
 * 读取 Android 原生 IME 高度（CSS 像素）。移动插件当前只暴露只读 command，
 * 因此所有 hook 共享一个轻量轮询器；避免每个终端标签各自建立定时请求。
 */
export function useImeInset(): number {
  const [ime, setIme] = useState(latestIme)

  useEffect(() => {
    if (!isMobileRuntime()) return
    const update = (next: number) => setIme(next)
    subscribers.add(update)
    setIme(latestIme)
    startImePolling()
    return () => {
      subscribers.delete(update)
      stopImePollingIfIdle()
    }
  }, [])

  return ime
}

/**
 * 以原生 IME inset 为主、visualViewport 为 iOS/浏览器预览兜底，返回实际键盘状态。
 * UI 不再把“请求打开键盘”和“键盘已经打开”混为同一份状态。
 */
export function useMobileKeyboardVisible(imeInset: number): boolean {
  const [viewportOpen, setViewportOpen] = useState(false)

  useEffect(() => {
    if (!isMobileRuntime()) return
    const viewport = window.visualViewport
    const sync = () => {
      const viewportHeight = viewport?.height ?? window.innerHeight
      setViewportOpen(isMobileKeyboardOpen(viewportHeight, window.innerHeight))
    }
    sync()
    viewport?.addEventListener('resize', sync)
    viewport?.addEventListener('scroll', sync)
    return () => {
      viewport?.removeEventListener('resize', sync)
      viewport?.removeEventListener('scroll', sync)
    }
  }, [])

  return imeInset > IME_OPEN_THRESHOLD_PX || viewportOpen
}
