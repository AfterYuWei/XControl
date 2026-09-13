import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTerminal } from '@/hooks/useTerminal'
import { useSessionChannel } from '@/hooks/useSessionChannel'
import { useSessionStore } from '@/store/session'
import { useProfileStore } from '@/store/profile'
import { useSettingsStore, useResolvedTheme } from '@/store/settings'
import { resolveTerminalThemeId } from '@/lib/terminalThemes'
import { sessionApi } from '@/api/session'
import { ConnectionDialog } from '@/components/ConnectionDialog'
import { useCompletion } from '@/hooks/useCompletion'
import { useMobileTerminalGestures } from '@/hooks/useMobileTerminalGestures'
import { IME_OPEN_THRESHOLD_PX, useImeInset, useMobileKeyboardVisible } from '@/hooks/useMobileIme'
import { CompletionPanel } from '@/components/Terminal/CompletionPanel'
import { AuthPromptDialog } from '@/components/Terminal/AuthPromptDialog'
import { MobileTerminalToolbar } from '@/components/Terminal/MobileTerminalToolbar'
import { TerminalActionMenu, type TerminalActionMenuItem } from '@/components/Terminal/TerminalActionMenu'
import { TerminalSelectionHandles } from '@/components/Terminal/TerminalSelectionHandles'
import { getTerminalSelectionClientRect } from '@/lib/terminalSelection'
import { isMobileRuntime } from '@/lib/platform'
import { writeClipboardText, readClipboardText } from '@/lib/clipboard'
import { toast } from 'sonner'
import { ClipboardPaste, Copy, TextSelect } from 'lucide-react'
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
  const {
    fontSize,
    mobileTerminalFontSize,
    fontFamily,
    fontFamilyCN,
    terminalTheme,
    terminalPopupMenu,
    setFontSize,
    setMobileTerminalFontSize,
  } = useSettingsStore()
  const isMobile = isMobileRuntime()
  const effectiveFontSize = isMobile ? mobileTerminalFontSize : fontSize

  // 默认字体大小（用于显示相对变化）
  const DEFAULT_FONT_SIZE = isMobile ? 10 : 7

  // 'default' 终端主题跟随应用深浅色（浅色切 one-light），显式选择的主题固定
  const resolvedAppTheme = useResolvedTheme()
  const effectiveTerminalTheme = resolveTerminalThemeId(terminalTheme, resolvedAppTheme)

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
  const [fontSizeHint, setFontSizeHint] = useState<{ show: boolean; size: number }>({
    show: false,
    size: effectiveFontSize,
  })
  const hasSpecificError = useRef(false)
  const fontSizeHintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const channelStatusRef = useRef<ChannelStatus>('connecting')
  const sendInputRef = useRef<(data: string) => void>(() => {})
  const sendResizeRef = useRef<(cols: number, rows: number) => void>(() => {})
  const handleDataRef = useRef<(data: string) => boolean>(() => false)
  const handleCompleteResponseRef = useRef<(payload: CompleteResponsePayload) => void>(() => {})
  const handleOutputDataRef = useRef<(data: string) => void>(() => {})

  const isReconnectingRef = useRef(false)
  const reconnectRequestPendingRef = useRef(false)

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
    const minimum = isMobile ? 8 : 6
    const newSize = Math.min(32, Math.max(minimum, effectiveFontSize + delta))
    if (isMobile) setMobileTerminalFontSize(newSize)
    else setFontSize(newSize)

    // 显示字体大小提示
    if (fontSizeHintTimeoutRef.current) {
      clearTimeout(fontSizeHintTimeoutRef.current)
    }
    setFontSizeHint({ show: true, size: newSize })
    fontSizeHintTimeoutRef.current = setTimeout(() => {
      setFontSizeHint({ show: false, size: newSize })
    }, 1500)
  }, [effectiveFontSize, isMobile, setFontSize, setMobileTerminalFontSize])

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

  const { write, writeln, clear, reset, fit, getSize, getTerminal, selectWordAt } = useTerminal({
    containerRef,
    fontSize: effectiveFontSize,
    fontFamily,
    fontFamilyCN,
    terminalTheme: effectiveTerminalTheme,
    onData: (data) => {
      if (tab.sessionId && tab.status === 'connected' && channelStatusRef.current === 'connected') {
        const consumed = handleDataRef.current(data)
        if (!consumed) sendInputRef.current(data)
      }
    },
    onFontSizeChange: handleFontSizeChange,
    onResize: handleTerminalResize,
  })

  // ── 移动端键盘门控与手势 ──────────────────────────────────────
  // 点按终端不再唤起软键盘：默认把 xterm 隐藏 textarea 置为 readOnly
  // （readOnly 聚焦不弹键盘），只有工具栏键盘开关显式放开才能呼出。
  const [actionMenu, setActionMenu] = useState<{
    open: boolean
    position: { x: number; y: number }
    items: TerminalActionMenuItem[]
    avoidRect?: { left: number; top: number; right: number; bottom: number }
  }>({ open: false, position: { x: 0, y: 0 }, items: [] })

  const imeInset = useImeInset()
  const keyboardVisible = useMobileKeyboardVisible(imeInset)
  const lastOpenImeInsetRef = useRef(0)
  const keyboardVisibleRef = useRef(keyboardVisible)
  const toolbarIntentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [toolbarImeInset, setToolbarImeInset] = useState(0)

  useEffect(() => {
    keyboardVisibleRef.current = keyboardVisible
    if (!isMobile) return
    if (imeInset > IME_OPEN_THRESHOLD_PX) {
      if (toolbarIntentTimerRef.current !== null) {
        clearTimeout(toolbarIntentTimerRef.current)
        toolbarIntentTimerRef.current = null
      }
      lastOpenImeInsetRef.current = imeInset
      setToolbarImeInset(imeInset)
    } else if (!keyboardVisible) {
      setToolbarImeInset(0)
    }
  }, [imeInset, isMobile, keyboardVisible])

  useEffect(() => {
    if (!isMobile) return
    const textarea = getTerminal()?.textarea
    if (!textarea) return
    textarea.readOnly = !keyboardVisible
    if (!keyboardVisible && document.activeElement === textarea) textarea.blur()
  }, [isMobile, keyboardVisible, getTerminal])

  const toggleKeyboard = useCallback(() => {
    const terminal = getTerminal()
    const textarea = terminal?.textarea
    if (!textarea) return
    if (toolbarIntentTimerRef.current !== null) {
      clearTimeout(toolbarIntentTimerRef.current)
      toolbarIntentTimerRef.current = null
    }
    if (keyboardVisible) {
      // 先让快捷栏与收键盘同时起步；按钮着色仍只跟随真实 IME 状态。
      setToolbarImeInset(0)
      textarea.readOnly = true
      terminal.blur()
    } else {
      // adjustPan 下原生 IME 高度通常到动画末尾才送达。用上次真实高度
      // （首次按屏幕比例估算）立即启动，再由原生值无缝校准终点。
      const predictedInset = lastOpenImeInsetRef.current
        || Math.min(360, Math.max(260, window.innerHeight * 0.4))
      setToolbarImeInset(predictedInset)
      toolbarIntentTimerRef.current = setTimeout(() => {
        toolbarIntentTimerRef.current = null
        if (!keyboardVisibleRef.current) setToolbarImeInset(0)
      }, 700)
      textarea.readOnly = false
      terminal.focus()
    }
  }, [getTerminal, keyboardVisible])

  // 单击清除选区（不唤起键盘）、双击选词+手柄、长按在按压处呼出悬浮菜单
  useMobileTerminalGestures(
    containerRef,
    {
      onSingleTap: () => {
        const terminal = getTerminal()
        if (terminal?.hasSelection()) terminal.clearSelection()
      },
      onDoubleTap: (position) => {
        selectWordAt(position.x, position.y)
      },
      onLongPress: (position) => {
        const terminal = getTerminal()
        const items: TerminalActionMenuItem[] = []
        if (terminal?.hasSelection()) {
          items.push({
            id: 'copy',
            label: '复制',
            icon: Copy,
            onSelect: () => {
              const selection = getTerminal()?.getSelection() ?? ''
              if (!selection) return
              void writeClipboardText(selection)
                .then(() => toast('已复制'))
                .catch(() => toast.error('复制失败，请重试'))
            },
          })
        }
        items.push({
          id: 'select-all',
          label: '全选',
          icon: TextSelect,
          onSelect: () => getTerminal()?.selectAll(),
        })
        items.push({
          id: 'paste',
          label: '粘贴',
          icon: ClipboardPaste,
          onSelect: () => {
            void readClipboardText()
              .then((text) => {
                if (text) sendInputRef.current(text)
              })
              .catch(() => toast.error('无法读取剪贴板'))
          },
        })
        setActionMenu({
          open: true,
          position,
          items,
          avoidRect: getTerminalSelectionClientRect(terminal),
        })
      },
    },
    isMobile,
  )

  const closeActionMenu = useCallback(() => {
    setActionMenu((state) => ({ ...state, open: false }))
  }, [])

  const resetReconnectState = useCallback(() => {
    isReconnectingRef.current = false
    reconnectRequestPendingRef.current = false
  }, [])

  const reconnectNow = useCallback(async () => {
    if (reconnectRequestPendingRef.current) return
    reconnectRequestPendingRef.current = true
    isReconnectingRef.current = true
    beginLocalConnection('正在请求 Rust 恢复远程会话')
    try {
      const { cols, rows } = getSize()
      const currentSessionId = useSessionStore.getState().tabs
        .find((candidate) => candidate.id === tab.id)?.sessionId
      const response = currentSessionId
        ? await sessionApi.reconnect(currentSessionId)
        : await sessionApi.create({ profile_id: tab.profileId, cols, rows })
      updateTabStatus(tab.id, 'connecting', response.session_id)
      reconnectRequestPendingRef.current = false
    } catch (cause) {
      resetReconnectState()
      const error = cause as SessionApiError
      const message = error?.error?.message || '无法恢复远程会话'
      markTabError(tab.id, tab.errorReason || 'unknown', message)
      setConnectionError(message)
      setDialogStatus('error')
    }
  }, [
    beginLocalConnection,
    getSize,
    markTabError,
    resetReconnectState,
    tab.errorReason,
    tab.id,
    tab.profileId,
    updateTabStatus,
  ])

  const currentHostKeyFingerprint = hostKeyPrompt.current

  const handleCancel = useCallback(() => {
    resetReconnectState()
    closeTab(tab.id)
  }, [closeTab, resetReconnectState, tab.id])

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
          resetReconnectState()
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
          resetReconnectState()
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
      clearTabError,
      clearTabHostKeyPrompt,
      fit,
      markTabReconnecting,
      tab.id,
      resetReconnectState,
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
      // 移动端从终端返回会话列表会卸载画布并主动取消前端订阅，SSH
      // 后端会话仍然存活，不能把这次组件清理误判成网络断线。
      // 真正的 disconnect/error 仍由 handleSessionMessage 处理。
      if (isMobile) return
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
      if (fontSizeHintTimeoutRef.current !== null) {
        clearTimeout(fontSizeHintTimeoutRef.current)
        fontSizeHintTimeoutRef.current = null
      }
      if (toolbarIntentTimerRef.current !== null) {
        clearTimeout(toolbarIntentTimerRef.current)
        toolbarIntentTimerRef.current = null
      }
    }
  }, [])

  const profileIcon = profiles.find((item) => item.id === tab.profileId)?.icon

  return (
    <div
      className="terminal-pane-root relative flex h-full w-full flex-col"
      style={{
        background: 'var(--term-bg)',
        '--terminal-ime-inset': `${toolbarImeInset}px`,
      } as CSSProperties}
    >
      <div ref={containerRef} className="term-host relative min-h-0 flex-1">
        {isMobile && <TerminalSelectionHandles getTerminal={getTerminal} hostRef={containerRef} />}
      </div>
      <MobileTerminalToolbar
        onInput={(data) => sendInputRef.current(data)}
        keyboardVisible={keyboardVisible}
        onToggleKeyboard={toggleKeyboard}
      />

      {isMobile && (
        <TerminalActionMenu
          open={actionMenu.open}
          position={actionMenu.position}
          containerRef={containerRef}
          items={actionMenu.items}
          avoidRect={actionMenu.avoidRect}
          onClose={closeActionMenu}
        />
      )}

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
