import { useEffect } from 'react'
import { useToastStore } from '@/store/toast'

export function Toast() {
  const { message, visible } = useToastStore()

  useEffect(() => {
    if (visible) {
      const t = setTimeout(() => useToastStore.getState().hideToast(), 1800)
      return () => clearTimeout(t)
    }
  }, [visible, message])

  return (
    <div
      className={`xcontrol-toast ${visible ? 'show' : ''}`}
      role="status"
      aria-live="polite"
    >
      {message}
    </div>
  )
}
