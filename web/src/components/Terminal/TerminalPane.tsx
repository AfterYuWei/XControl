import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTerminal } from '@/hooks/useTerminal'
import { useSessionChannel } from '@/hooks/useSessionChannel'
import { useSessionStore } from '@/store/session'
import { useProfileStore } from '@/store/profile'
import { useSettingsStore } from '@/store/settings'
import { sessionApi } from '@/api/session'
import { ConnectionDialog } from '@/components/ConnectionDialog'
import { useCompletion } from '@/hooks/useCompletion'
import { CompletionPanel } from '@/components/Terminal/CompletionPanel'
import { AuthPromptDialog } from '@/components/Terminal/AuthPromptDialog'
import { MobileTerminalToolbar } from '@/components/Terminal/MobileTerminalToolbar'
import type {
  AuthenticationRequestPayload,
  CompleteResponsePayload,
  ConnectionLogEntry,
  ConnectionStatePayload,
  CwdPayload,
  DisconnectPayload,
  ErrorPayload,
  MetaPayload,
  SessionMessage,
} from '@/types/sessionMessage'
import type { SessionApiError } from '@/types/session'

type ChannelStatus = 'connecting' | 'connected' | 'disconnected'

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
  const [authRequest, setAuthRequest] = useState<AuthenticationRequestPayload>()
  const [fontSizeHint, setFontSizeHint] = useState<{ show: boolean; size: number }>({ show: false, size: fontSize })
  const hasSpecificError = useRef(false)
  const fontSizeHintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const channelStatusRef = useRef<ChannelStatus>('connecting')
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

  // Last size reported to the backend. Skipping duplicate reports avoids
  // flooding the WS during font load / fit retries, where xterm fires
  // onResize multiple times with the same dimensions.
  const lastReportedSizeRef = useRef<{ cols: number; rows: number } | null>(null)

  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    if (cols <= 0 || rows <= 0) return
    if (!tab.sessionId || channelStatusRef.current !== 'connected') return
    const last = lastReportedSizeRef.current
    if (last && last.cols === cols && last.rows === rows) return
    lastReportedSizeRef.current = { cols, rows }
    sendResizeRef.current(cols, rows)
  }, [tab.sessionId])

  const { write, writeln, clear, reset, fit, getSize, getTerminal } = useTerminal({
    containerRef,
    fontSize,
    fontFamily,
    fontFamilyCN,
    terminalTheme,
    onData: (data) => {
      if (tab.sessionId && tab.status === 'connected' && channelStatusRef.current === 'connected') {
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
            // Request the PTY with the terminal's real size instead of the
            // 80x24 default, so full-screen apps render correctly from the
            // first frame after reconnect.
            const { cols, rows } = getSize()
            const currentSessionId = useSessionStore.getState().tabs
              .find((candidate) => candidate.id === tabId)?.sessionId
            const resp = currentSessionId
              ? await sessionApi.reconnect(currentSessionId)
              : await sessionApi.create({ profile_id: profileId, cols, rows })
            updateTabStatus(tabId, 'connecting', resp.session_id)
            isReconnectingRef.current = false
          } catch {
            attempt(index + 1)
          }
        }, delay)
      }

      attempt(0)
    },
    [beginLocalConnection, getSize, markTabError, markTabReconnecting, updateTabStatus],
  )

  const reconnectNow = useCallback(() => {
    clearReconnectTimer()
    startAutoReconnect(tab.id, tab.profileId, tab.errorReason || 'unknown')
  }, [clearReconnectTimer, startAutoReconnect, tab.errorReason, tab.id, tab.profileId])

  const currentHostKeyFingerprint = hostKeyPrompt.current

  const handleCancel = useCallback(() => {
    clearReconnectTimer()
    closeTab(tab.id)
  }, [clearReconnectTimer, closeTab, tab.id])

  const decideHostKey = useCallback(async (
    decision: 'trust_once' | 'trust_permanently' | 'reject',
  ) => {
    if (!tab.sessionId || !currentHostKeyFingerprint) return

    try {
      await sessionApi.decideHostKey(tab.sessionId, currentHostKeyFingerprint, decision)
      clearTabHostKeyPrompt(tab.id)
      setHostKeyPrompt({})
      if (decision === 'reject') {
        handleCancel()
        return
      }
      setDialogStatus('connecting')
      setConnectionError('')
    } catch (err) {
      const apiErr = err as SessionApiError
      setConnectionError(apiErr?.error?.message || '无法继续连接到服务器')
      setDialogStatus('error')
    }
  }, [clearTabHostKeyPrompt, currentHostKeyFingerprint, handleCancel, tab.id, tab.sessionId])

  const handleSessionMessage = useCallback(
    (msg: SessionMessage) => {
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
          } else if (payload?.status === 'reconnecting') {
            isReconnectingRef.current = true
            markTabReconnecting(tab.id, payload.retry_attempt || 1, payload.next_retry_at || Date.now())
            setDialogStatus('reconnecting')
            setShowDialog(true)
          } else if (payload?.status === 'connecting' && !isReconnectingRef.current) {
            setDialogStatus('connecting')
          }
          break
        }

        case 'metadata': {
          const meta = msg.payload as MetaPayload
          updateTabStatus(tab.id, 'connected', meta.session_id)
          clearReconnectTimer()
          clearTabError(tab.id)
          clearTabHostKeyPrompt(tab.id)
          hasSpecificError.current = false
          setConnectionError('')
          setBackendStage('ready')
          setDialogStatus('connected')
          setTimeout(() => setShowDialog(false), 500)
          // The session was created with the default 80x24 PTY (the real
          // terminal size is only known after mount). Push the actual size
          // once the shell is confirmed ready, after fonts have settled, so
          // vim/htop and friends render at the correct dimensions even if
          // the earlier resize raced with shell startup.
          lastReportedSizeRef.current = null
          setTimeout(() => {
            fit()
          }, 100)
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

        case 'auth_request': {
          const payload = msg.payload as AuthenticationRequestPayload
          if (payload?.request_id) {
            setAuthRequest(payload)
            setShowDialog(false)
          }
          break
        }

        case 'exit':
          clearReconnectTimer()
          updateTabStatus(tab.id, 'disconnected')
          writeln('\r\n\x1b[33m[会话已结束]\x1b[0m')
          break

        case 'disconnect': {
          const payload = msg.payload as DisconnectPayload
          const message = payload?.message || '连接已断开'
          hasSpecificError.current = true
          setConnectionError(message)
          setDialogStatus('reconnecting')
          setShowDialog(true)
          writeln(`\r\n\x1b[31m[连接已断开: ${message}]\x1b[0m`)
          markTabReconnecting(tab.id, 1, Date.now() + 1000)
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
      clearReconnectTimer,
      clearTabError,
      clearTabHostKeyPrompt,
      fit,
      markTabReconnecting,
      tab.id,
      updateTabCwd,
      updateTabStatus,
      write,
      writeln,
    ],
  )

  const { status: channelStatus, latency, sendInput, sendResize, sendComplete } = useSessionChannel({
    sessionId: tab.sessionId || '',
    onMessage: handleSessionMessage,
    onOpen: () => {
      // Live events remain queued until onOpen and the initial replay finish,
      // so this clears only the previous session, never the new login banner.
      reset()
      clear()
      // fit() reports the resulting size through onResize, which forwards
      // it to the backend. Delayed slightly so the container has settled.
      setTimeout(() => {
        fit()
      }, 50)
    },
    onClose: () => {
      if (channelStatusRef.current === 'connected' && !hasSpecificError.current && !isReconnectingRef.current) {
        hasSpecificError.current = true
        setConnectionError('连接已断开')
        setDialogStatus('reconnecting')
        setShowDialog(true)
        writeln('\r\n\x1b[31m[连接已断开]\x1b[0m')
        markTabReconnecting(tab.id, 1, Date.now() + 1000)
      }
    },
    onError: () => {
      if (!hasSpecificError.current) {
        setConnectionError('无法连接到服务器')
      }
    },
  })

  const {
    popup,
    handleData,
    reset: resetCompletion,
    handleCompleteResponse,
    handleOutputData,
    hoverSelect,
    clickSelect,
    expandDirectory,
  } = useCompletion({
    getTerminal,
    sendInput,
    sendComplete,
    getCwd,
    enabled: terminalPopupMenu,
  })

  useEffect(() => {
    channelStatusRef.current = channelStatus
    sendInputRef.current = sendInput
    sendResizeRef.current = sendResize
    handleDataRef.current = handleData
    handleCompleteResponseRef.current = handleCompleteResponse
    handleOutputDataRef.current = handleOutputData
  }, [channelStatus, handleCompleteResponse, handleData, handleOutputData, sendInput, sendResize])

  useEffect(() => {
    if (channelStatus === 'disconnected') resetCompletion()
  }, [channelStatus, resetCompletion])

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
      if (!currentHostKeyFingerprint) {
        setDialogStatus('connecting')
      }
      setConnectionError('')
      hasSpecificError.current = false
    }
  }, [backendLogs.length, beginLocalConnection, currentHostKeyFingerprint, localLogs.length, tab.sessionId, tab.status])

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
    if (channelStatus === 'disconnected' && tab.status === 'connecting' && tab.sessionId && !hasSpecificError.current) {
      setConnectionError('无法连接到服务器')
      setDialogStatus('error')
    }
  }, [channelStatus, tab.sessionId, tab.status])

  // When the tab becomes active, immediately re-fit and report the size —
  // the container was zero-sized while hidden, so the backend may still
  // hold stale dimensions. Container resizes (sidebar collapse, window
  // drag, panel split) are debounced; fit() reports the size via onResize.
  useEffect(() => {
    if (!isActive) return

    fit()
    let observerTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (observerTimer) clearTimeout(observerTimer)
      observerTimer = setTimeout(() => {
        observerTimer = null
        fit()
      }, 100)
    })

    if (containerRef.current) observer.observe(containerRef.current)
    return () => {
      observer.disconnect()
      if (observerTimer) clearTimeout(observerTimer)
    }
  }, [fit, isActive])

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
    <div className="terminal-pane-root relative flex h-full w-full flex-col" style={{ background: 'var(--term-bg)' }}>
      <div ref={containerRef} className="term-host min-h-0 flex-1" />
      <MobileTerminalToolbar
        onInput={(data) => sendInputRef.current(data)}
        onHideKeyboard={() => getTerminal()?.blur()}
      />

      <CompletionPanel
        popup={popup}
        getTerminal={getTerminal}
        containerRef={containerRef}
        onHoverItem={hoverSelect}
        onClickItem={clickSelect}
        onExpandDir={expandDirectory}
      />

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
        onHostKeyDecision={decideHostKey}
      />
      <AuthPromptDialog
        request={authRequest}
        onCancel={handleCancel}
        onSubmit={(responses) => {
          if (!authRequest) return
          void sessionApi.respondAuth(authRequest.request_id, responses).then(() => {
            setAuthRequest(undefined)
            setShowDialog(true)
          }).catch((error: SessionApiError) => {
            setConnectionError(error?.error?.message || '提交认证信息失败')
            setDialogStatus('error')
            setAuthRequest(undefined)
            setShowDialog(true)
          })
        }}
      />
    </div>
  )
}
