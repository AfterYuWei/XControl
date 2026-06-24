import { useEffect, useRef, useCallback } from 'react'

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
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  const connect = useCallback(() => {
    if (!sessionId) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api/sftp/ws?session_id=${encodeURIComponent(sessionId)}`

    const ws = new WebSocket(wsUrl)
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
              p.status ?? ''
            )
            break
          case 'transfer_complete':
            callbacksRef.current.onComplete?.(
              p.task_id ?? '',
              p.status ?? 'completed',
              p.finished_at ?? Date.now()
            )
            break
          case 'transfer_failed':
            callbacksRef.current.onFailed?.(
              p.task_id ?? '',
              p.status ?? 'failed',
              p.error_message ?? 'unknown error'
            )
            break
          case 'sftp_session_status':
            callbacksRef.current.onSessionStatus?.(
              p.session_id ?? '',
              p.status ?? ''
            )
            break
          case 'pong':
            break
        }
      } catch {
        // ignore malformed messages
      }
    }

    ws.onerror = () => {
      // Will trigger onclose; reconnect logic below
    }

    ws.onclose = () => {
      wsRef.current = null
      // Reconnect after 3 seconds if the session is still active
      if (sessionId) {
        setTimeout(() => {
          if (sessionId && !wsRef.current) {
            connect()
          }
        }, 3000)
      }
    }

    // Heartbeat: send ping every 30 seconds
    pingRef.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, 30000)
  }, [sessionId])

  useEffect(() => {
    connect()

    return () => {
      if (pingRef.current) {
        clearInterval(pingRef.current)
        pingRef.current = null
      }
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [connect])
}
