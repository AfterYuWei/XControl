import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  ConnectionLogEntry,
  ConnectionStatePayload,
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
    clearTabHostKeyPrompt,
  } = useSessionStore()
  const { profiles } = useProfileStore()
  const { fontSize, fontFamily, fontFamilyCN, terminalTheme, terminalPopupMenu, setFontSize } = useSettingsStore()

  // 默认字体大小（用于显示相对变化）
  const DEFAULT_FONT_SIZE = 13

  const [showDialog, setShowDialog] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [dialogStatus, setDialogStatus] = useState<'connecting' | 'connected' | 'error' | 'reconnecting' | 'hostkey'>(
    'connecting',
  )
  const [localStage, setLocalStage] = useState('submitting')
  const [backendStage, setBackendStage] = useState('')
  const [localLogs, setLocalLogs] = useState<ConnectionLogEntry[]>([])
  const [backendLogs, setBackendLogs] = useState<ConnectionLogEntry[]>([])
  const [hostKeyPrompt, setHostKeyPrompt] = useState<{ current?: string; known?: string }>({})
  const [fontSizeHint, setFontSizeHint] = useState<{ show: boolean; size: number }>({ show: false, size: fontSize })
  const hasSpecificError = useRef(false)
  const fontSizeHintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const beginLocalConnection = useCallback((message: string) => {
    setShowDialog(true)
    setDialogStatus('connecting')
    setConnectionError('')
    setLocalStage('submitting')
    setBackendStage('')
    setBackendLogs([])
    setHostKeyPrompt({})
    setLocalLogs([
      {
        at: Date.now(),
        level: 'info',
        stage: 'submitting',
        message,
      },
    ])
    hasSpecificError.current = false
  }, [])

  const effectiveStage = backendStage || localStage || 'submitting'
  const connectionLogs = useMemo(
    () => [...localLogs, ...backendLogs].sort((a, b) => a.at - b.at),
    [backendLogs, localLogs],
  )

  const handleFontSizeChange = useCallback((delta: number) => {
    const newSize = Math.min(32, Math.max(8, fontSize + delta))
    setFontSize(newSize)

    // 显示字体大小提示
    if (fontSizeHintTimeoutRef.current) {
      clearTimeout(fontSizeHintTimeoutRef.current)
    }
    setFontSizeHint({ show: true, size: newSize })
    fontSizeHintTimeoutRef.current = setTimeout(() => {
      setFontSizeHint({ show: false, size: newSize })
    }, 1500)
  }, [fontSize, setFontSize])

  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    if (tab.sessionId && wsStatusRef.current === 'connected') {
      sendResizeRef.current(cols, rows)
    }
  }, [tab.sessionId])

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
    onFontSizeChange: handleFontSizeChange,
    onResize: handleTerminalResize,
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
          markTabError(tabId, reason, '自动重连失败，请手动重新连接')
          setDialogStatus('error')
          return
        }

        const delay = RECONNECT_BACKOFF[index]
        const nextRetryAt = Date.now() + delay
        markTabReconnecting(tabId, index + 1, nextRetryAt)

        reconnectTimerRef.current = setTimeout(async () => {
          reconnectTimerRef.current = null
          try {
            beginLocalConnection(`正在发起第 ${index + 1} 次重连请求`)
            const resp = await sessionApi.create({ profile_id: profileId, cols: 80, rows: 24 })
            updateTabStatus(tabId, 'connecting', resp.session_id)
            isReconnectingRef.current = false
          } catch {
            attempt(index + 1)
          }
        }, delay)
      }

      attempt(0)
    },
    [beginLocalConnection, markTabError, markTabReconnecting, updateTabStatus],
  )

  const reconnectNow = useCallback(() => {
    clearReconnectTimer()
    startAutoReconnect(tab.id, tab.profileId, tab.errorReason || 'unknown')
  }, [clearReconnectTimer, startAutoReconnect, tab.errorReason, tab.id, tab.profileId])

  const confirmHostKey = useCallback(async () => {
    if (!tab.sessionId || !hostKeyPrompt.current) return

    try {
      await sessionApi.confirmHostKey(tab.sessionId, hostKeyPrompt.current)
      clearTabHostKeyPrompt(tab.id)
      setHostKeyPrompt({})
      setDialogStatus('connecting')
      setConnectionError('')
    } catch (err) {
      const apiErr = err as SessionApiError
      setConnectionError(apiErr?.error?.message || '无法继续连接到服务器')
      setDialogStatus('error')
    }
  }, [clearTabHostKeyPrompt, hostKeyPrompt.current, tab.id, tab.sessionId])

  const handleWSMessage = useCallback(
    (msg: WSMessage) => {
      switch (msg.type) {
        case 'output':
          if (msg.data) {
            write(msg.data)
            handleOutputDataRef.current(msg.data)
          }
          break

        case 'connection_state': {
          const payload = msg.payload as ConnectionStatePayload
          if (payload?.stage) setBackendStage(payload.stage)
          if (payload?.logs) setBackendLogs(payload.logs)
          if (payload?.error) setConnectionError(payload.error)

          if (payload?.waiting_for_host_key || payload?.stage === 'hostkey_confirm') {
            setHostKeyPrompt({
              current: payload.host_key_fingerprint,
              known: payload.known_host_key_fingerprint,
            })
            setDialogStatus('hostkey')
            setShowDialog(true)
            setConnectionError('')
          } else if (payload?.status === 'connecting' && !isReconnectingRef.current) {
            setDialogStatus('connecting')
          }
          break
        }

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
          setBackendStage('ready')
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
    if (tab.status === 'connecting' && !tab.sessionId && localLogs.length === 0 && backendLogs.length === 0) {
      beginLocalConnection('已发起连接请求，正在创建连接会话')
      return
    }

    if (tab.status === 'connecting') {
      setShowDialog(true)
      if (!hostKeyPrompt.current) {
        setDialogStatus('connecting')
      }
      setConnectionError('')
      hasSpecificError.current = false
    }
  }, [backendLogs.length, beginLocalConnection, hostKeyPrompt.current, localLogs.length, tab.sessionId, tab.status])

  useEffect(() => {
    if (tab.hostKeyFingerprint) {
      setHostKeyPrompt({
        current: tab.hostKeyFingerprint,
        known: tab.knownHostKeyFingerprint,
      })
      setShowDialog(true)
      setDialogStatus('hostkey')
    }
  }, [tab.hostKeyFingerprint, tab.knownHostKeyFingerprint])

  useEffect(() => {
    if (tab.status === 'error') {
      setShowDialog(true)
      setDialogStatus('error')
      setConnectionError(tab.errorMessage || '无法连接到服务器')
    }
  }, [tab.errorMessage, tab.status])

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
      if (fontSizeHintTimeoutRef.current !== null) {
        clearTimeout(fontSizeHintTimeoutRef.current)
        fontSizeHintTimeoutRef.current = null
      }
    }
  }, [])

  const profileIcon = profiles.find((item) => item.id === tab.profileId)?.icon

  return (
    <div className="relative h-full w-full" style={{ background: 'var(--term-bg)' }}>
      <div ref={containerRef} className="h-full w-full" />

      <CompletionPanel popup={popup} getTerminal={getTerminal} containerRef={containerRef} />

      {/* 字体大小悬浮提示 */}
      {fontSizeHint.show && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            padding: '6px 12px',
            background: 'var(--bg-panel)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            fontFamily: 'ui-sans-serif, system-ui',
            fontSize: 12,
            color: 'var(--fg)',
            zIndex: 50,
            opacity: fontSizeHint.show ? 1 : 0,
            transition: 'opacity 0.15s ease',
          }}
        >
          <span style={{ fontWeight: 600 }}>{fontSizeHint.size}px</span>
          <span style={{ color: 'var(--fg-4)', marginLeft: 8 }}>
            {fontSizeHint.size === DEFAULT_FONT_SIZE
              ? '默认'
              : `${fontSizeHint.size > DEFAULT_FONT_SIZE ? '+' : ''}${fontSizeHint.size - DEFAULT_FONT_SIZE}`}
          </span>
        </div>
      )}

      <ConnectionDialog
        key={showDialog ? `${tab.id}-${dialogStatus}-${tab.sessionId ?? 'pending'}` : 'closed'}
        open={showDialog}
        onOpenChange={setShowDialog}
        profileName={tab.profileName}
        host={tab.host || '未知'}
        port={tab.port || 22}
        username={tab.username || 'root'}
        icon={profileIcon}
        status={dialogStatus}
        currentStage={effectiveStage}
        logs={connectionLogs}
        errorMessage={connectionError}
        onCancel={handleCancel}
        reconnectAttempt={tab.reconnectAttempt}
        nextRetryAt={tab.nextRetryAt}
        onReconnectNow={reconnectNow}
        hostKeyFingerprint={hostKeyPrompt.current || tab.hostKeyFingerprint}
        knownHostKeyFingerprint={hostKeyPrompt.known || tab.knownHostKeyFingerprint}
        onConfirmHostKey={confirmHostKey}
      />
    </div>
  )
}
