import { useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'

interface SftpEvent {
  type: string
  payload?: {
    task_id?: string
    transferred?: number
    size?: number
    speed?: number
    status?: string
    finished_at?: number
    error_message?: string
    session_id?: string
  }
}

export interface SftpTransferCallbacks {
  onProgress?: (taskId: string, transferred: number, size: number, speed: number, status: string) => void
  onComplete?: (taskId: string, status: string, finishedAt: number) => void
  onFailed?: (taskId: string, status: string, errorMessage: string) => void
  onSessionStatus?: (sessionId: string, status: string) => void
}

/** 订阅 Rust SFTP 领域通过 Tauri event 推送的会话状态与传输进度。 */
export function useSftpTransfer(sessionId: string | null, callbacks: SftpTransferCallbacks) {
  const callbacksRef = useRef(callbacks)

  useEffect(() => {
    callbacksRef.current = callbacks
  }, [callbacks])

  useEffect(() => {
    if (!sessionId) return
    let disposed = false
    let cleanup: (() => void) | undefined

    void listen<SftpEvent>('xcontrol-sftp-message', ({ payload: message }) => {
      const payload = message.payload ?? {}
      const eventSessionId = payload.session_id
      if (eventSessionId && eventSessionId !== sessionId) return
      switch (message.type) {
        case 'transfer_progress':
          callbacksRef.current.onProgress?.(
            payload.task_id ?? '', payload.transferred ?? 0, payload.size ?? 0,
            payload.speed ?? 0, payload.status ?? '',
          )
          break
        case 'transfer_complete':
          callbacksRef.current.onComplete?.(
            payload.task_id ?? '', payload.status ?? 'completed', payload.finished_at ?? Date.now(),
          )
          break
        case 'transfer_failed':
          callbacksRef.current.onFailed?.(
            payload.task_id ?? '', payload.status ?? 'failed', payload.error_message ?? 'unknown error',
          )
          break
        case 'sftp_session_status':
          callbacksRef.current.onSessionStatus?.(payload.session_id ?? '', payload.status ?? '')
          break
      }
    }).then((unlisten) => {
      if (disposed) unlisten()
      else cleanup = unlisten
    })

    return () => {
      disposed = true
      cleanup?.()
    }
  }, [sessionId])
}
