import { useEffect, useRef, useCallback, useState } from 'react'
import type { WSMessage } from '@/types/ws'

type WSStatus = 'connecting' | 'connected' | 'disconnected'

interface UseWebSocketOptions {
  sessionId: string
  onMessage?: (msg: WSMessage) => void
  onOpen?: (event?: Event) => void
  onClose?: () => void
  onError?: (error: Event) => void
}

export function useWebSocket(options: UseWebSocketOptions) {
  const { sessionId, onMessage, onOpen, onClose, onError } = options
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<WSStatus>('connecting')
  const [latency, setLatency] = useState<number | null>(null)
  const pingTimeRef = useRef<number>(0)

  // Store callbacks in refs so the effect only depends on sessionId
  const callbacksRef = useRef({ onMessage, onOpen, onClose, onError })

  useEffect(() => {
    callbacksRef.current = { onMessage, onOpen, onClose, onError }
  })

  useEffect(() => {
    if (!sessionId) return

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = `${protocol}//${window.location.host}/ws?session_id=${sessionId}`

      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = (event) => {
        setStatus('connected')
        callbacksRef.current.onOpen?.(event)
      }

      ws.onmessage = (event) => {
        try {
          const msg: WSMessage = JSON.parse(event.data)
          // Handle pong internally for latency measurement
          if (msg.type === 'pong' && pingTimeRef.current > 0) {
            const rtt = Date.now() - pingTimeRef.current
            setLatency(rtt)
            pingTimeRef.current = 0
            return
          }
          callbacksRef.current.onMessage?.(msg)
        } catch (err) {
          console.error('Failed to parse WS message:', err)
        }
      }

      ws.onclose = () => {
        setStatus('disconnected')
        setLatency(null)
        callbacksRef.current.onClose?.()
      }

      ws.onerror = (error) => {
        callbacksRef.current.onError?.(error)
      }
    }

    connect()

    // Heartbeat with latency measurement (every 5 seconds)
    const heartbeat = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        pingTimeRef.current = Date.now()
        wsRef.current.send(JSON.stringify({ type: 'ping' }))
      }
    }, 5000)

    return () => {
      clearInterval(heartbeat)
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [sessionId])

  const send = useCallback((msg: WSMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  const sendInput = useCallback((data: string) => {
    send({ type: 'input', data })
  }, [send])

  const sendResize = useCallback((cols: number, rows: number) => {
    send({ type: 'resize', payload: { cols, rows } })
  }, [send])

  return {
    status,
    latency,
    send,
    sendInput,
    sendResize,
  }
}
