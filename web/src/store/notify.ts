import { create } from 'zustand'

export type NotifyType = 'error' | 'warning' | 'success' | 'info'

export interface NotificationItem {
  id: string
  type: NotifyType
  message: string
  title?: string
  duration: number      // ms; 0 = 不自动关闭
  createdAt: number
}

// 队列上限:超过移除最旧的(队列头部),避免无限堆积遮挡视野
const MAX_VISIBLE = 5

// 类型默认时长:error 需要用户看清(5s),warning(4s),success/info(3s)
const DEFAULT_DURATION: Record<NotifyType, number> = {
  error: 5000,
  warning: 4000,
  success: 3000,
  info: 3000,
}

interface NotifyState {
  notifications: NotificationItem[]
  push: (type: NotifyType, message: string, opts?: { title?: string; duration?: number }) => string
  dismiss: (id: string) => void
  clear: () => void
}

export const useNotifyStore = create<NotifyState>((set) => ({
  notifications: [],
  push: (type, message, opts) => {
    const id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const item: NotificationItem = {
      id,
      type,
      message,
      title: opts?.title,
      duration: opts?.duration ?? DEFAULT_DURATION[type],
      createdAt: Date.now(),
    }
    set((s) => {
      const next = [...s.notifications, item]
      // 超出上限:移除最旧的(队列头部)
      if (next.length > MAX_VISIBLE) next.splice(0, next.length - MAX_VISIBLE)
      return { notifications: next }
    })
    return id
  },
  dismiss: (id) => set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
  clear: () => set({ notifications: [] }),
}))

// ── 统一调用接口(任意位置可调用) ──
export const notify = {
  error:   (msg: string, opts?: { title?: string; duration?: number }) => useNotifyStore.getState().push('error', msg, opts),
  warning: (msg: string, opts?: { title?: string; duration?: number }) => useNotifyStore.getState().push('warning', msg, opts),
  success: (msg: string, opts?: { title?: string; duration?: number }) => useNotifyStore.getState().push('success', msg, opts),
  info:    (msg: string, opts?: { title?: string; duration?: number }) => useNotifyStore.getState().push('info', msg, opts),
  dismiss: (id: string) => useNotifyStore.getState().dismiss(id),
  clear:   () => useNotifyStore.getState().clear(),
}

// ── 兼容层:旧 toast(msg) → 新 notify.info(msg) ──
// 保留以避免改动现有调用点的逻辑;新代码请直接用 notify.xxx()
export function toast(msg: string) {
  notify.info(msg)
}
