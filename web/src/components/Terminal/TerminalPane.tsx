import { useEffect, useRef, useCallback, useState } from 'react'
import { useTerminal } from '@/hooks/useTerminal'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useSessionStore } from '@/store/session'
import { useProfileStore } from '@/store/profile'
import { useSettingsStore } from '@/store/settings'
import { sessionApi } from '@/api/session'
import { ConnectionDialog } from '@/components/ConnectionDialog'
import { useCompletion } from '@/hooks/useCompletion'
import { CompletionPanel } from '@/components/Terminal/CompletionPanel'
import type { WSMessage, MetaPayload, ErrorPayload, CwdPayload, CompleteResponsePayload, DisconnectPayload } from '@/types/ws'

type WSStatus = 'connecting' | 'connected' | 'disconnected'

// Auto-reconnect configuration: exponential backoff (ms), max attempts.
// After MAX_RECONNECT_ATTEMPTS, the dialog switches to manual reconnect mode.
const RECONNECT_BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]
const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF.length

interface TerminalPaneProps {
  tab: {
    id: string
    profileId: string
    profileName: string
    sessionId: string | null
    status: 'connecting' | 'connected' | 'disconnected' | 'error' | 'reconnecting'
    host?: string
    port?: number
    username?: string
    errorReason?: string
    errorMessage?: string
    reconnectAttempt?: number
    nextRetryAt?: number
  }
  isActive: boolean
}

export function TerminalPane({ tab, isActive }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { updateTabStatus, updateTabCwd, updateTabLatency, markTabError, markTabReconnecting, clearTabError, closeTab } = useSessionStore()
  const { profiles } = useProfileStore()
  const { fontSize, fontFamily, fontFamilyCN, terminalTheme, terminalPopupMenu } = useSettingsStore()
  const [showDialog, setShowDialog] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [dialogStatus, setDialogStatus] = useState<'connecting' | 'connected' | 'error' | 'reconnecting'>('connecting')
  const hasSpecificError = useRef(false)

  const wsStatusRef = useRef<WSStatus>('connecting')
  const sendInputRef = useRef<(data: string) => void>(() => {})
  const sendResizeRef = useRef<(cols: number, rows: number) => void>(() => {})
  const handleDataRef = useRef<(data: string) => boolean>(() => false)
  const handleCompleteResponseRef = useRef<(payload: CompleteResponsePayload) => void>(() => {})
  const handleOutputDataRef = useRef<(data: string) => void>(() => {})

  // Auto-reconnect state: timer ref + attempt counter. The timer is cleared on
  // unmount, manual cancel, or successful reconnection.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)
  const isReconnectingRef = useRef(false)

  // 从 session store 读取 OSC7 追踪到的 cwd,供动态补全解析相对路径
  const cwd = useSessionStore((state) => state.tabs.find((t) => t.id === tab.id)?.cwd)
  const cwdRef = useRef(cwd)
  useEffect(() => { cwdRef.current = cwd }, [cwd])
  const getCwd = useCallback(() => cwdRef.current, [])

  const { write, writeln, clear, reset, fit, getSize, getTerminal } = useTerminal({
    containerRef,
    fontSize,
    fontFamily,
    fontFamilyCN,
    terminalTheme,
    onData: (data) => {
      if (tab.sessionId && wsStatusRef.current === 'connected') {
        const consumed = handleDataRef.current(data)
        if (!consumed) sendInputRef.current(data)
      }
    },
  })

  // clearReconnectTimer cancels any pending reconnect timer and resets the
  // reconnecting flag. Safe to call multiple times.
  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    isReconnectingRef.current = false
  }, [])

  // startAutoReconnect begins an exponential-backoff reconnection loop.
  // On each attempt it creates a new SSH session via the REST API and updates
  // tab.sessionId, which triggers useWebSocket to establish a fresh WS.
  // After MAX_RECONNECT_ATTEMPTS, the dialog switches to manual reconnect.
  const startAutoReconnect = useCallback((tabId: string, profileId: string, reason: string) => {
    // Don't start a second loop if one is already running
    if (isReconnectingRef.current) return
    isReconnectingRef.current = true
    reconnectAttemptRef.current = 0

    const attempt = (n: number) => {
      if (n >= MAX_RECONNECT_ATTEMPTS) {
        // Exhausted: switch to manual reconnect mode
        isReconnectingRef.current = false
        markTabError(tabId, reason, '自动重连失败，请手动重连')
        setDialogStatus('error')
        return
      }
      const delay = RECONNECT_BACKOFF[n]
      const nextRetryAt = Date.now() + delay
      reconnectAttemptRef.current = n + 1
      markTabReconnecting(tabId, n + 1, nextRetryAt)

      reconnectTimerRef.current = setTimeout(async () => {
        reconnectTimerRef.current = null
        try {
          // Create a new SSH session. The backend reuses the profile's
          // credentials to establish a fresh connection.
          const resp = await sessionApi.create({ profile_id: profileId, cols: 80, rows: 24 })
          // updateTabStatus with a new sessionId triggers useWebSocket's
          // [sessionId] effect to close the old WS and open a new one.
          updateTabStatus(tabId, 'connecting', resp.session_id)
          // The dialog stays open in 'connecting' state until metadata arrives
          setDialogStatus('connecting')
          // Stop the reconnect loop; metadata handler will close the dialog
          isReconnectingRef.current = false
        } catch {
          // Reconnect attempt failed; schedule the next attempt
          attempt(n + 1)
        }
      }, delay)
    }
    attempt(0)
  }, [markTabError, markTabReconnecting, updateTabStatus])

  // reconnectNow is called when the user clicks "立即重连" or "重新连接".
  // It cancels any pending timer and immediately attempts reconnection.
  const reconnectNow = useCallback(() => {
    clearReconnectTimer()
    const reason = tab.errorReason || 'unknown'
    // Reset attempt counter and start fresh from attempt 1
    isReconnectingRef.current = false
    reconnectAttemptRef.current = 0
    startAutoReconnect(tab.id, tab.profileId, reason)
  }, [clearReconnectTimer, startAutoReconnect, tab.id, tab.profileId, tab.errorReason])

  const handleWSMessage = useCallback(
    (msg: WSMessage) => {
      switch (msg.type) {
        case 'output':
          if (msg.data) {
            write(msg.data)
            handleOutputDataRef.current(msg.data)
          }
          break
        case 'metadata': {
          const meta = msg.payload as MetaPayload
          reset()
          clear()
          updateTabStatus(tab.id, 'connected', meta.session_id)
          // Clear any reconnect state from a successful reconnection
          clearReconnectTimer()
          clearTabError(tab.id)
          hasSpecificError.current = false
          setConnectionError('')
          setDialogStatus('connected')
          setTimeout(() => setShowDialog(false), 500)
          break
        }
        case 'cwd': {
          const cwd = msg.payload as CwdPayload
          if (cwd?.path) {
            updateTabCwd(tab.id, cwd.path)
          }
          break
        }
        case 'complete_response': {
          const resp = msg.payload as CompleteResponsePayload
          if (resp) {
            handleCompleteResponseRef.current(resp)
          }
          break
        }
        case 'exit':
          // Normal shell exit (user typed "exit"). Stop any reconnect loop.
          clearReconnectTimer()
          updateTabStatus(tab.id, 'disconnected')
          writeln('\r\n\x1b[33m[会话已结束]\x1b[0m')
          break
        case 'disconnect': {
          // Abnormal disconnect: SSH connection died (remote shutdown,
          // keepalive timeout, network error). Trigger auto-reconnect.
          const disc = msg.payload as DisconnectPayload
          const reason = disc?.reason || 'unknown'
          const message = disc?.message || '连接已断开'
          hasSpecificError.current = true
          setConnectionError(message)
          setDialogStatus('reconnecting')
          setShowDialog(true)
          writeln(`\r\n\x1b[31m[连接已断开: ${message}]\x1b[0m`)
          startAutoReconnect(tab.id, tab.profileId, reason)
          break
        }
        case 'error': {
          const err = msg.payload as ErrorPayload
          hasSpecificError.current = true
          setConnectionError(err.message)
          setDialogStatus('error')
          updateTabStatus(tab.id, 'disconnected')
          break
        }
      }
    },
    [tab.id, tab.profileId, updateTabStatus, updateTabCwd, write, writeln, clear, reset, clearReconnectTimer, clearTabError, startAutoReconnect]
  )

  const { status: wsStatus, latency, sendInput, sendResize, sendComplete } = useWebSocket({
    sessionId: tab.sessionId || '',
    onMessage: handleWSMessage,
    onOpen: () => {
      // Delay to ensure terminal layout is complete before reading size
      setTimeout(() => {
        fit()
        const { cols, rows } = getSize()
        sendResizeRef.current(cols, rows)
      }, 50)
    },
    onClose: () => {
      // Fallback: if the WS closes unexpectedly while we were connected and
      // no specific disconnect/error message was received, treat it as an
      // abnormal disconnect and trigger auto-reconnect. This catches cases
      // where the backend dies or the network drops between client and backend
      // without the SSH-level death detection firing first.
      // Guard: skip if already handling an error or already reconnecting.
      if (wsStatusRef.current === 'connected' && !hasSpecificError.current && !isReconnectingRef.current) {
        hasSpecificError.current = true
        setConnectionError('连接已断开')
        setDialogStatus('reconnecting')
        setShowDialog(true)
        writeln('\r\n\x1b[31m[连接已断开]\x1b[0m')
        startAutoReconnect(tab.id, tab.profileId, 'network_error')
      }
    },
    onError: () => {
      if (!hasSpecificError.current) {
        setConnectionError('无法连接到服务器')
      }
    },
  })

  const { popup, handleData, reset: resetCompletion, handleCompleteResponse, handleOutputData } = useCompletion({
    getTerminal,
    sendInput,
    sendComplete,
    getCwd,
    enabled: terminalPopupMenu,
  })

  useEffect(() => {
    wsStatusRef.current = wsStatus
    sendInputRef.current = sendInput
    sendResizeRef.current = sendResize
    handleDataRef.current = handleData
    handleCompleteResponseRef.current = handleCompleteResponse
    handleOutputDataRef.current = handleOutputData
  }, [wsStatus, sendInput, sendResize, handleData, handleCompleteResponse, handleOutputData])

  useEffect(() => {
    if (wsStatus === 'disconnected') {
      resetCompletion()
    }
  }, [wsStatus, resetCompletion])

  // Sync latency to session store
  useEffect(() => {
    if (latency !== null) {
      updateTabLatency(tab.id, latency)
    }
  }, [latency, tab.id, updateTabLatency])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (tab.status === 'connecting' && tab.sessionId) {
      setShowDialog(true)
      setDialogStatus('connecting')
      setConnectionError('')
      hasSpecificError.current = false
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [tab.status, tab.sessionId])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (wsStatus === 'disconnected' && tab.status === 'connecting' && !hasSpecificError.current) {
      setConnectionError('无法连接到服务器')
      setDialogStatus('error')
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [wsStatus, tab.status])

  useEffect(() => {
    if (!isActive) return

    // Explicitly fit when the pane becomes visible; otherwise a terminal created
    // while the pane was hidden (display: none) can leave a clipped/offset top row.
    fit()

    const observer = new ResizeObserver(() => {
      fit()
      const { cols, rows } = getSize()
      if (tab.sessionId && wsStatusRef.current === 'connected') {
        sendResizeRef.current(cols, rows)
      }
    })

    if (containerRef.current) {
      observer.observe(containerRef.current)
    }

    return () => observer.disconnect()
  }, [isActive, tab.sessionId, fit, getSize])

  const handleCancel = () => {
    // "关闭标签" button: stop any reconnect loop and close the tab.
    clearReconnectTimer()
    closeTab(tab.id)
  }

  // Cleanup reconnect timer on unmount to prevent leaks and stray retries.
  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }
  }, [])

  const profileIcon = profiles.find((p) => p.id === tab.profileId)?.icon

  return (
    <div className="h-full w-full relative" style={{ background: 'var(--term-bg)' }}>
      <div ref={containerRef} className="h-full w-full" />

      <CompletionPanel popup={popup} getTerminal={getTerminal} containerRef={containerRef} />

      <ConnectionDialog
        key={showDialog ? tab.id : 'closed'}
        open={showDialog}
        onOpenChange={setShowDialog}
        profileName={tab.profileName}
        host={tab.host || '未知'}
        port={tab.port || 22}
        username={tab.username || 'root'}
        icon={profileIcon}
        status={dialogStatus}
        errorMessage={connectionError}
        onCancel={handleCancel}
        reconnectAttempt={tab.reconnectAttempt}
        nextRetryAt={tab.nextRetryAt}
        onReconnectNow={reconnectNow}
      />
    </div>
  )
}
