import { useCallback, useEffect, useRef, useState } from 'react'
import { useTerminal } from '@/hooks/useTerminal'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useSessionStore } from '@/store/session'
import { useProfileStore } from '@/store/profile'
import { useSettingsStore } from '@/store/settings'
import { sessionApi } from '@/api/session'
import { ConnectionDialog } from '@/components/ConnectionDialog'
import { useCompletion } from '@/hooks/useCompletion'
import { CompletionPanel } from '@/components/Terminal/CompletionPanel'
import type {
  CompleteResponsePayload,
  CwdPayload,
  DisconnectPayload,
  ErrorPayload,
  MetaPayload,
  WSMessage,
} from '@/types/ws'
import type { SessionApiError } from '@/types/session'

type WSStatus = 'connecting' | 'connected' | 'disconnected'

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
    hostKeyFingerprint?: string
    knownHostKeyFingerprint?: string
  }
  isActive: boolean
}

function isHostKeyChangedError(err: SessionApiError): boolean {
  return err?.error?.code === 'HOST_KEY_CHANGED' && !!err.host_fingerprint
}

export function TerminalPane({ tab, isActive }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const {
    updateTabStatus,
    updateTabCwd,
    updateTabLatency,
    markTabError,
    markTabReconnecting,
    clearTabError,
    closeTab,
    setTabHostKeyPrompt,
    clearTabHostKeyPrompt,
  } = useSessionStore()
  const { profiles } = useProfileStore()
  const { fontSize, fontFamily, fontFamilyCN, terminalTheme, terminalPopupMenu } = useSettingsStore()

  const [showDialog, setShowDialog] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [dialogStatus, setDialogStatus] = useState<'connecting' | 'connected' | 'error' | 'reconnecting' | 'hostkey'>('connecting')
  const hasSpecificError = useRef(false)

  const wsStatusRef = useRef<WSStatus>('connecting')
  const sendInputRef = useRef<(data: string) => void>(() => {})
  const sendResizeRef = useRef<(cols: number, rows: number) => void>(() => {})
  const handleDataRef = useRef<(data: string) => boolean>(() => false)
  const handleCompleteResponseRef = useRef<(payload: CompleteResponsePayload) => void>(() => {})
  const handleOutputDataRef = useRef<(data: string) => void>(() => {})

  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isReconnectingRef = useRef(false)

  const cwd = useSessionStore((state) => state.tabs.find((item) => item.id === tab.id)?.cwd)
  const cwdRef = useRef(cwd)
  useEffect(() => {
    cwdRef.current = cwd
  }, [cwd])
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

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    isReconnectingRef.current = false
  }, [])

  const startAutoReconnect = useCallback(
    (tabId: string, profileId: string, reason: string) => {
      if (isReconnectingRef.current) return
      isReconnectingRef.current = true

      const attempt = (index: number) => {
        if (index >= MAX_RECONNECT_ATTEMPTS) {
          isReconnectingRef.current = false
          markTabError(tabId, reason, '自动重连失败，请手动重连')
          setDialogStatus('error')
          return
        }

        const delay = RECONNECT_BACKOFF[index]
        const nextRetryAt = Date.now() + delay
        markTabReconnecting(tabId, index + 1, nextRetryAt)

        reconnectTimerRef.current = setTimeout(async () => {
          reconnectTimerRef.current = null
          try {
            const resp = await sessionApi.create({ profile_id: profileId, cols: 80, rows: 24 })
            updateTabStatus(tabId, 'connecting', resp.session_id)
            setDialogStatus('connecting')
            isReconnectingRef.current = false
          } catch (err) {
            const apiErr = err as SessionApiError
            if (isHostKeyChangedError(apiErr)) {
              setTabHostKeyPrompt(tabId, apiErr.host_fingerprint!, apiErr.known_host_fingerprint)
              isReconnectingRef.current = false
              return
            }
            attempt(index + 1)
          }
        }, delay)
      }

      attempt(0)
    },
    [markTabError, markTabReconnecting, setTabHostKeyPrompt, updateTabStatus],
  )

  const reconnectNow = useCallback(() => {
    clearReconnectTimer()
    startAutoReconnect(tab.id, tab.profileId, tab.errorReason || 'unknown')
  }, [clearReconnectTimer, startAutoReconnect, tab.errorReason, tab.id, tab.profileId])

  const confirmHostKey = useCallback(async () => {
    if (!tab.hostKeyFingerprint) return
    try {
      const resp = await sessionApi.create({
        profile_id: tab.profileId,
        cols: 80,
        rows: 24,
        confirmed_host_key_fingerprint: tab.hostKeyFingerprint,
      })
      clearTabHostKeyPrompt(tab.id)
      updateTabStatus(tab.id, 'connecting', resp.session_id)
      setDialogStatus('connecting')
      setConnectionError('')
    } catch (err) {
      const apiErr = err as SessionApiError
      if (isHostKeyChangedError(apiErr)) {
        setTabHostKeyPrompt(tab.id, apiErr.host_fingerprint!, apiErr.known_host_fingerprint)
        return
      }
      setConnectionError(apiErr?.error?.message || '无法连接到服务器')
      setDialogStatus('error')
    }
  }, [clearTabHostKeyPrompt, setTabHostKeyPrompt, tab.hostKeyFingerprint, tab.id, tab.profileId, updateTabStatus])

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
          clearReconnectTimer()
          clearTabError(tab.id)
          clearTabHostKeyPrompt(tab.id)
          hasSpecificError.current = false
          setConnectionError('')
          setDialogStatus('connected')
          setTimeout(() => setShowDialog(false), 500)
          break
        }
        case 'cwd': {
          const payload = msg.payload as CwdPayload
          if (payload?.path) updateTabCwd(tab.id, payload.path)
          break
        }
        case 'complete_response': {
          const payload = msg.payload as CompleteResponsePayload
          if (payload) handleCompleteResponseRef.current(payload)
          break
        }
        case 'exit':
          clearReconnectTimer()
          updateTabStatus(tab.id, 'disconnected')
          writeln('\r\n\x1b[33m[会话已结束]\x1b[0m')
          break
        case 'disconnect': {
          const payload = msg.payload as DisconnectPayload
          const reason = payload?.reason || 'unknown'
          const message = payload?.message || '连接已断开'
          hasSpecificError.current = true
          setConnectionError(message)
          setDialogStatus('reconnecting')
          setShowDialog(true)
          writeln(`\r\n\x1b[31m[连接已断开: ${message}]\x1b[0m`)
          startAutoReconnect(tab.id, tab.profileId, reason)
          break
        }
        case 'error': {
          const payload = msg.payload as ErrorPayload
          hasSpecificError.current = true
          setConnectionError(payload.message)
          setDialogStatus('error')
          updateTabStatus(tab.id, 'disconnected')
          break
        }
      }
    },
    [
      clear,
      clearReconnectTimer,
      clearTabError,
      clearTabHostKeyPrompt,
      reset,
      startAutoReconnect,
      tab.id,
      tab.profileId,
      updateTabCwd,
      updateTabStatus,
      write,
      writeln,
    ],
  )

  const { status: wsStatus, latency, sendInput, sendResize, sendComplete } = useWebSocket({
    sessionId: tab.sessionId || '',
    onMessage: handleWSMessage,
    onOpen: () => {
      setTimeout(() => {
        fit()
        const { cols, rows } = getSize()
        sendResizeRef.current(cols, rows)
      }, 50)
    },
    onClose: () => {
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
  }, [handleCompleteResponse, handleData, handleOutputData, sendInput, sendResize, wsStatus])

  useEffect(() => {
    if (wsStatus === 'disconnected') resetCompletion()
  }, [resetCompletion, wsStatus])

  useEffect(() => {
    if (latency !== null) {
      updateTabLatency(tab.id, latency)
    }
  }, [latency, tab.id, updateTabLatency])

  useEffect(() => {
    if (tab.hostKeyFingerprint) {
      setShowDialog(true)
      setDialogStatus('hostkey')
      setConnectionError('')
      return
    }
    if (tab.status === 'connecting' && tab.sessionId) {
      setShowDialog(true)
      setDialogStatus('connecting')
      setConnectionError('')
      hasSpecificError.current = false
    }
  }, [tab.hostKeyFingerprint, tab.sessionId, tab.status])

  useEffect(() => {
    if (wsStatus === 'disconnected' && tab.status === 'connecting' && tab.sessionId && !hasSpecificError.current) {
      setConnectionError('无法连接到服务器')
      setDialogStatus('error')
    }
  }, [tab.sessionId, tab.status, wsStatus])

  useEffect(() => {
    if (!isActive) return

    fit()
    const observer = new ResizeObserver(() => {
      fit()
      const { cols, rows } = getSize()
      if (tab.sessionId && wsStatusRef.current === 'connected') {
        sendResizeRef.current(cols, rows)
      }
    })

    if (containerRef.current) observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [fit, getSize, isActive, tab.sessionId])

  const handleCancel = () => {
    clearReconnectTimer()
    closeTab(tab.id)
  }

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }
  }, [])

  const profileIcon = profiles.find((item) => item.id === tab.profileId)?.icon

  return (
    <div className="h-full w-full relative" style={{ background: 'var(--term-bg)' }}>
      <div ref={containerRef} className="h-full w-full" />

      <CompletionPanel popup={popup} getTerminal={getTerminal} containerRef={containerRef} />

      <ConnectionDialog
        key={showDialog ? `${tab.id}-${dialogStatus}` : 'closed'}
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
        hostKeyFingerprint={tab.hostKeyFingerprint}
        knownHostKeyFingerprint={tab.knownHostKeyFingerprint}
        onConfirmHostKey={confirmHostKey}
      />
    </div>
  )
}
