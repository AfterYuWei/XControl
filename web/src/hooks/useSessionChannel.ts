import { useCallback, useEffect, useRef, useState } from 'react'
import { Channel } from '@tauri-apps/api/core'
import { sessionApi } from '@/api/session'
import type { SessionMessage } from '@/types/sessionMessage'

type ChannelStatus = 'connecting' | 'connected' | 'disconnected'

interface UseSessionChannelOptions {
  sessionId: string
  onMessage?: (msg: SessionMessage) => void
  onOpen?: (event?: Event) => void
  onClose?: () => void
  onError?: (error: Event) => void
}

export function useSessionChannel(options: UseSessionChannelOptions) {
  const { sessionId, onMessage, onOpen, onClose, onError } = options
  const [status, setStatus] = useState<ChannelStatus>('connecting')
  const [latency, setLatency] = useState<number | null>(null)
  const pingTimeRef = useRef(0)
  const callbacksRef = useRef({ onMessage, onOpen, onClose, onError })

  useEffect(() => {
    callbacksRef.current = { onMessage, onOpen, onClose, onError }
  })

  useEffect(() => {
    if (!sessionId) return

    let disposed = false
    let subscriptionId: string | undefined

    const dispatch = (message: SessionMessage) => {
      if (message.type === 'pong' && pingTimeRef.current > 0) {
        setLatency(Date.now() - pingTimeRef.current)
        pingTimeRef.current = 0
        return
      }
      callbacksRef.current.onMessage?.(message)
      if (message.type === 'exit' || message.type === 'disconnect' || message.type === 'error') {
        setStatus('disconnected')
      }
    }

    const attach = async () => {
      try {
        // After the backend flips a session to `attached`, new output is sent
        // as live events and is no longer included in the attach response.
        // Queue those events until the initial replay has been dispatched so
        // metadata can never overtake terminal output such as the login banner.
        let attaching = true
        const pendingEvents: SessionMessage[] = []
        const channel = new Channel<SessionMessage>()
        channel.onmessage = (message) => {
          if (attaching) {
            pendingEvents.push(message)
          } else {
            dispatch(message)
          }
        }
        subscriptionId = await sessionApi.subscribe(sessionId, channel)
        if (disposed) {
          void sessionApi.unsubscribe(sessionId, subscriptionId).catch(() => undefined)
          return
        }
        setStatus('connected')
        callbacksRef.current.onOpen?.()
        attaching = false
        pendingEvents.forEach(dispatch)
      } catch (error) {
        if (disposed) return
        setStatus('disconnected')
        callbacksRef.current.onError?.(new Event('error'))
        console.error('Failed to attach Rust SSH session:', error)
      }
    }

    void attach()
    const heartbeat = setInterval(() => {
      pingTimeRef.current = Date.now()
      void sessionApi.ping(sessionId).catch(() => {
        pingTimeRef.current = 0
      })
    }, 30000)

    return () => {
      disposed = true
      clearInterval(heartbeat)
      if (subscriptionId) {
        void sessionApi.unsubscribe(sessionId, subscriptionId).catch(() => undefined)
      }
      setLatency(null)
      callbacksRef.current.onClose?.()
    }
  }, [sessionId])

  const send = useCallback(
    (message: SessionMessage) => {
      switch (message.type) {
        case 'input':
          void sessionApi.input(sessionId, message.data ?? '').catch(console.error)
          break
        case 'resize': {
          const payload = message.payload as { cols?: number; rows?: number }
          if (payload?.cols && payload?.rows) {
            void sessionApi.resize(sessionId, payload.cols, payload.rows).catch(console.error)
          }
          break
        }
        case 'ping':
          void sessionApi.ping(sessionId).catch(console.error)
          break
        default:
          break
      }
    },
    [sessionId],
  )

  const sendInput = useCallback((data: string) => {
    void sessionApi.input(sessionId, data).catch(console.error)
  }, [sessionId])

  const sendResize = useCallback((cols: number, rows: number) => {
    void sessionApi.resize(sessionId, cols, rows).catch(console.error)
  }, [sessionId])

  const sendComplete = useCallback((requestId: string, script: string, cwd?: string) => {
    void sessionApi.complete(sessionId, requestId, script, cwd).catch(console.error)
  }, [sessionId])

  return { status, latency, send, sendInput, sendResize, sendComplete }
}
