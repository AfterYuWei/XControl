import { useEffect, useRef, useCallback, useState } from 'react'
import { useTerminal } from '@/hooks/useTerminal'
import { useWebSocket } from '@/hooks/useWebSocket'
import { useSessionStore } from '@/store/session'
import { useSettingsStore } from '@/store/settings'
import { ConnectionDialog } from '@/components/ConnectionDialog'
import type { WSMessage, MetaPayload, ErrorPayload } from '@/types/ws'

interface TerminalPaneProps {
  tab: {
    id: string
    profileId: string
    profileName: string
    sessionId: string | null
    status: 'connecting' | 'connected' | 'disconnected'
    host?: string
    port?: number
    username?: string
  }
  isActive: boolean
}

export function TerminalPane({ tab, isActive }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { updateTabStatus } = useSessionStore()
  const { fontSize, fontFamily } = useSettingsStore()
  const [showDialog, setShowDialog] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [dialogStatus, setDialogStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const hasSpecificError = useRef(false)

  const handleWSMessage = useCallback(
    (msg: WSMessage) => {
      switch (msg.type) {
        case 'output':
          if (msg.data) {
            write(msg.data)
          }
          break
        case 'metadata':
          const meta = msg.payload as MetaPayload
          reset()
          clear()
          updateTabStatus(tab.id, 'connected', meta.session_id)
          setDialogStatus('connected')
          setTimeout(() => setShowDialog(false), 500)
          break
        case 'exit':
          updateTabStatus(tab.id, 'disconnected')
          writeln('\r\n\x1b[33m[会话已结束]\x1b[0m')
          break
        case 'error':
          const err = msg.payload as ErrorPayload
          hasSpecificError.current = true
          setConnectionError(err.message)
          setDialogStatus('error')
          updateTabStatus(tab.id, 'disconnected')
          break
      }
    },
    [tab.id, updateTabStatus]
  )

  const { status: wsStatus, sendInput, sendResize } = useWebSocket({
    sessionId: tab.sessionId || '',
    onMessage: handleWSMessage,
    onOpen: () => {
      // Delay to ensure terminal layout is complete before reading size
      setTimeout(() => {
        fit()
        const { cols, rows } = getSize()
        sendResize(cols, rows)
      }, 50)
    },
    onError: () => {
      if (!hasSpecificError.current) {
        setConnectionError('无法连接到服务器')
      }
    },
  })

  const { write, writeln, clear, reset, fit, getSize } = useTerminal({
    containerRef,
    fontSize,
    fontFamily,
    onData: (data) => {
      if (tab.sessionId && wsStatus === 'connected') {
        sendInput(data)
      }
    },
  })

  useEffect(() => {
    if (tab.status === 'connecting' && tab.sessionId) {
      setShowDialog(true)
      setDialogStatus('connecting')
      setConnectionError('')
      hasSpecificError.current = false
    }
  }, [tab.status, tab.sessionId])

  useEffect(() => {
    if (wsStatus === 'disconnected' && tab.status === 'connecting' && !hasSpecificError.current) {
      setConnectionError('无法连接到服务器')
      setDialogStatus('error')
    }
  }, [wsStatus, tab.status])

  useEffect(() => {
    if (!isActive) return

    const observer = new ResizeObserver(() => {
      fit()
      const { cols, rows } = getSize()
      if (tab.sessionId && wsStatus === 'connected') {
        sendResize(cols, rows)
      }
    })

    if (containerRef.current) {
      observer.observe(containerRef.current)
    }

    return () => observer.disconnect()
  }, [isActive, tab.sessionId, wsStatus, fit, getSize, sendResize])

  const handleCancel = () => {
    updateTabStatus(tab.id, 'disconnected')
  }

  return (
    <div className="h-full w-full bg-[#1a1b26] p-1 relative">
      <div ref={containerRef} className="h-full w-full" />

      <ConnectionDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        profileName={tab.profileName}
        host={tab.host || '未知'}
        port={tab.port || 22}
        username={tab.username || 'root'}
        status={dialogStatus}
        errorMessage={connectionError}
        onCancel={handleCancel}
      />
    </div>
  )
}
