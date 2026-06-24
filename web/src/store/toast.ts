import { create } from 'zustand'

interface ToastState {
  message: string
  visible: boolean
  showToast: (msg: string) => void
  hideToast: () => void
}

export const useToastStore = create<ToastState>((set) => ({
  message: '',
  visible: false,
  showToast: (msg) => {
    set({ message: msg, visible: true })
  },
  hideToast: () => set({ visible: false }),
}))

let toastTimer: ReturnType<typeof setTimeout> | undefined

export function toast(msg: string) {
  const store = useToastStore.getState()
  store.showToast(msg)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => store.hideToast(), 1800)
}
