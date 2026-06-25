import { useEffect, useRef } from 'react'
import { useServerDetailStore } from '@/store/serverDetail'
import type { ServerInfo, ServerMetrics } from '@/api/serverDetail'

/**
 * Manages the WebSocket connection for real-time server metrics.
 * Connects when the management session is connected, disconnects on unmount.
 */
export function useServerMetrics(profileId: string) {
  const { getStatus, updateMetrics, updateInfo, setWsConnected } = useServerDetailStore()
  const detail = getStatus(profileId)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!detail.sessionId || detail.status !== 'connected') {
      return
    }

    let disposed = false

    function connect() {
      if (disposed) return

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${protocol}//${window.location.host}/api/server/ws?session_id=${detail.sessionId}`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        if (disposed) return
        setWsConnected(profileId, true)
        // Subscribe to metrics
        ws.send(JSON.stringify({ type: 'subscribe_metrics' }))
      }

      ws.onmessage = (ev) => {
        if (disposed) return
        try {
          const msg = JSON.parse(ev.data)
          switch (msg.type) {
            case 'metrics':
              updateMetrics(profileId, msg.data as ServerMetrics)
              break
            case 'info':
              updateInfo(profileId, msg.data as ServerInfo)
              break
            case 'pong':
              break
            default:
              break
          }
        } catch {
          // ignore malformed messages
        }
      }

      ws.onclose = () => {
        if (disposed) return
        setWsConnected(profileId, false)
        wsRef.current = null
        // Reconnect after 3 seconds if still connected
        if (!disposed && detail.status === 'connected') {
          reconnectTimer.current = setTimeout(connect, 3000)
        }
      }

      ws.onerror = () => {
        // onclose will handle reconnection
      }
    }

    connect()

    // Heartbeat ping every 30 seconds
    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }))
      }
    }, 30000)

    return () => {
      disposed = true
      clearInterval(pingInterval)
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [detail.sessionId, detail.status, profileId, updateMetrics, updateInfo, setWsConnected])
}
