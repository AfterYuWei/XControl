import { useEffect, useRef } from 'react'
import { wsUrl } from '@/lib/desktop'
import { useServerDetailStore } from '@/store/serverDetail'
import type { ServerInfo, ServerMetrics } from '@/api/serverDetail'

/**
 * Manages the WebSocket connection for real-time server metrics.
 * Connects when the management session is connected, disconnects on unmount.
 */
export function useServerMetrics(profileId: string, active: boolean) {
  const sessionId = useServerDetailStore((s) => s.details[profileId]?.sessionId ?? null)
  const status = useServerDetailStore((s) => s.details[profileId]?.status ?? 'idle')
  const updateMetrics = useServerDetailStore((s) => s.updateMetrics)
  const updateInfo = useServerDetailStore((s) => s.updateInfo)
  const setWsConnected = useServerDetailStore((s) => s.setWsConnected)
  const markDisconnected = useServerDetailStore((s) => s.markDisconnected)
  const ensureConnected = useServerDetailStore((s) => s.ensureConnected)

  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!active) {
      return
    }

    if (status === 'idle' || status === 'disconnected') {
      void ensureConnected(profileId)
      return
    }

    if (!sessionId || status !== 'connected') {
      return
    }

    const activeSessionId = sessionId
    let disposed = false

    function connect() {
      if (disposed) return

      const url = wsUrl('/api/server/ws', { session_id: activeSessionId })
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        if (disposed) return
        setWsConnected(profileId, true)
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
        if (status === 'connected') {
          markDisconnected(profileId, '管理连接已断开，正在重连')
        }
      }

      ws.onerror = () => {
        // onclose handles reconnection
      }
    }

    connect()

    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }))
      }
    }, 30000)

    return () => {
      disposed = true
      clearInterval(pingInterval)
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [active, ensureConnected, markDisconnected, profileId, sessionId, setWsConnected, status, updateInfo, updateMetrics])
}
