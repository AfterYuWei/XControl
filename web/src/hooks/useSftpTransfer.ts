import { useEffect, useRef } from 'react'
import { wsUrl } from '@/lib/desktop'

/** WebSocket message from the SFTP transfer progress channel. */
interface SftpWsMessage {
  type: string
  data?: string
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

/**
 * Connects to the SFTP WebSocket endpoint and dispatches transfer progress
 * messages to the provided callbacks. The connection is server-push only;
 * the hook sends periodic ping messages to keep the connection alive.
 *
 * @param sessionId The SFTP session ID to subscribe to.
 * @param callbacks Callbacks for progress, completion, failure, and session status.
 */
export function useSftpTransfer(sessionId: string | null, callbacks: SftpTransferCallbacks) {
  const wsRef = useRef<WebSocket | null>(null)
  const callbacksRef = useRef(callbacks)

  useEffect(() => {
    callbacksRef.current = callbacks
  }, [callbacks])

  useEffect(() => {
    if (!sessionId) return
    const activeSessionId = sessionId

    let disposed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let pingTimer: ReturnType<typeof setInterval> | null = null

    function clearPing() {
      if (pingTimer) {
        clearInterval(pingTimer)
        pingTimer = null
      }
    }

    function connect() {
      if (disposed) return

      // URLSearchParams 自动做 URL 编码（原 encodeURIComponent 逻辑已包含）
      const url = wsUrl('/api/sftp/ws', { session_id: activeSessionId })
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onmessage = (event) => {
        try {
          const msg: SftpWsMessage = JSON.parse(event.data)
          const p = msg.payload ?? {}
          switch (msg.type) {
            case 'transfer_progress':
              callbacksRef.current.onProgress?.(
                p.task_id ?? '',
                p.transferred ?? 0,
                p.size ?? 0,
                p.speed ?? 0,
                p.status ?? '',
              )
              break
            case 'transfer_complete':
              callbacksRef.current.onComplete?.(
                p.task_id ?? '',
                p.status ?? 'completed',
                p.finished_at ?? Date.now(),
              )
              break
            case 'transfer_failed':
              callbacksRef.current.onFailed?.(
                p.task_id ?? '',
                p.status ?? 'failed',
                p.error_message ?? 'unknown error',
              )
              break
            case 'sftp_session_status':
              callbacksRef.current.onSessionStatus?.(
                p.session_id ?? '',
                p.status ?? '',
              )
              break
            case 'pong':
              break
          }
        } catch {
          // Ignore malformed messages.
        }
      }

      ws.onerror = () => {
        // onclose performs the retry.
      }

      ws.onclose = () => {
        clearPing()
        if (wsRef.current === ws) {
          wsRef.current = null
        }
        if (!disposed) {
          reconnectTimer = setTimeout(connect, 3000)
        }
      }

      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, 30000)
    }

    connect()

    return () => {
      disposed = true
      clearPing()
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
      }
      const ws = wsRef.current
      if (ws) {
        ws.onclose = null
        ws.close()
        wsRef.current = null
      }
    }
  }, [sessionId])
}
