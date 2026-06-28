import { useEffect, useState } from 'react'
import { Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { resolveServerIcon } from '@/lib/serverIcons'

interface ConnectionStep {
  id: string
  label: string
  status: 'pending' | 'active' | 'done' | 'error'
  detail?: string
}

interface ConnectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  profileName: string
  host: string
  port: number
  username: string
  icon?: string
  status: 'connecting' | 'connected' | 'error' | 'reconnecting'
  errorMessage?: string
  onCancel?: () => void
  // Lifecycle management: auto-reconnect support
  reconnectAttempt?: number  // current attempt (1-based)
  nextRetryAt?: number       // timestamp (ms) of next scheduled retry
  onReconnectNow?: () => void // "重连" button handler
}

export function ConnectionDialog({
  open,
  onOpenChange,
  profileName,
  host,
  port,
  username,
  icon,
  status,
  errorMessage,
  onCancel,
  reconnectAttempt,
  nextRetryAt,
  onReconnectNow,
}: ConnectionDialogProps) {
  const [elapsed, setElapsed] = useState(0)
  // Countdown (ms) until next retry; updates every 100ms for smooth progress bar.
  const [remainingMs, setRemainingMs] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (status !== 'connected') return
    const timer = setTimeout(() => onOpenChange(false), 500)
    return () => clearTimeout(timer)
  }, [status, onOpenChange])

  // Countdown timer for reconnecting state
  useEffect(() => {
    if (status !== 'reconnecting' || !nextRetryAt) {
      setRemainingMs(0)
      return
    }
    const update = () => {
      const remaining = Math.max(0, nextRetryAt - Date.now())
      setRemainingMs(remaining)
    }
    update()
    const timer = setInterval(update, 100)
    return () => clearInterval(timer)
  }, [status, nextRetryAt])

  const getStatusIcon = (stepStatus: ConnectionStep['status']) => {
    switch (stepStatus) {
      case 'done':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />
      case 'error':
        return <XCircle className="h-4 w-4 text-red-500" />
      case 'active':
        return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
      default:
        return <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/30" />
    }
  }

  if (!open) return null

  const ServerIcon = resolveServerIcon(icon)
  const timeout = 120
  const remaining = Math.max(0, timeout - elapsed)

  // Backoff duration for progress bar width (must match TerminalPane backoff array)
  const backoffForAttempt = (n: number): number => {
    const table = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]
    return table[Math.min(n - 1, table.length - 1)] || 30000
  }

  const steps: ConnectionStep[] = (() => {
    // Reconnecting: show disconnect notice + retry progress
    if (status === 'reconnecting') {
      return [
        { id: 'disconnect', label: '连接已断开', status: 'error', detail: errorMessage },
        {
          id: 'retry',
          label: reconnectAttempt
            ? `正在重连（第 ${reconnectAttempt} 次）${remainingMs > 0 ? `，${Math.ceil(remainingMs / 1000)}s 后重试` : ''}`
            : '正在重连...',
          status: 'active',
        },
      ]
    }

    // Error (reconnect exhausted or initial connect failure)
    if (status === 'error') {
      return [
        { id: 'disconnect', label: '连接已断开', status: 'error', detail: errorMessage },
        { id: 'failed', label: '自动重连失败，请手动重连', status: 'error' },
      ]
    }

    // Connected
    if (status === 'connected') {
      const baseSteps: ConnectionStep[] = [
        { id: 'init', label: '初始化安全通道', status: 'pending' },
        { id: 'resolve', label: `解析主机 ${host}`, status: 'pending' },
        { id: 'connect', label: `连接到 ${host}:${port}`, status: 'pending' },
        { id: 'auth', label: 'SSH 认证', status: 'pending' },
        { id: 'shell', label: '启动 Shell', status: 'pending' },
      ]
      return baseSteps.map((step) => ({ ...step, status: 'done' as const }))
    }

    // Connecting
    const baseSteps: ConnectionStep[] = [
      { id: 'init', label: '初始化安全通道', status: 'pending' },
      { id: 'resolve', label: `解析主机 ${host}`, status: 'pending' },
      { id: 'connect', label: `连接到 ${host}:${port}`, status: 'pending' },
      { id: 'auth', label: 'SSH 认证', status: 'pending' },
      { id: 'shell', label: '启动 Shell', status: 'pending' },
    ]

    const activeIndex = elapsed >= 2 ? 3 : elapsed >= 1 ? 2 : 1
    // During initial connecting, show steps progressing. If errorMessage is set
    // (e.g. SSH connect failure), mark the active step as error.
    if (errorMessage) {
      return baseSteps.map((step, i) => {
        if (i < activeIndex) return { ...step, status: 'done' as const }
        if (i === activeIndex) return { ...step, status: 'error' as const, detail: errorMessage }
        return step
      })
    }

    if (elapsed < 1) {
      baseSteps[0].status = 'done'
      baseSteps[1].status = 'active'
    } else if (elapsed < 2) {
      baseSteps[0].status = 'done'
      baseSteps[1].status = 'done'
      baseSteps[2].status = 'active'
    } else {
      baseSteps[0].status = 'done'
      baseSteps[1].status = 'done'
      baseSteps[2].status = 'done'
      baseSteps[3].status = 'active'
    }
    return baseSteps
  })()

  // Progress bar width
  const progressWidth = (() => {
    if (status === 'connected') return '100%'
    if (status === 'error') return '100%'
    if (status === 'reconnecting') {
      if (!nextRetryAt || !reconnectAttempt) return '100%'
      const total = backoffForAttempt(reconnectAttempt)
      const elapsedMs = total - remainingMs
      return `${Math.min(100, (elapsedMs / total) * 100)}%`
    }
    // connecting
    return `${Math.min(80, (elapsed / timeout) * 100)}%`
  })()

  // Header accent color
  const headerGradient = (status === 'reconnecting' || status === 'error')
    ? 'from-amber-500 to-orange-600'
    : 'from-blue-500 to-blue-600'

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => onOpenChange(false)} />
      <div className="relative z-50 w-full max-w-md bg-background rounded-xl shadow-modal overflow-hidden">
        {/* Header */}
        <div className="p-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className={`h-10 w-10 rounded-lg bg-gradient-to-br ${headerGradient} flex items-center justify-center text-white`}>
                {status === 'reconnecting' || status === 'error' ? (
                  <AlertTriangle size={20} />
                ) : (
                  <ServerIcon size={20} />
                )}
              </div>
              <div>
                <h3 className="font-semibold text-base">{profileName}</h3>
                <p className="text-sm text-muted-foreground">
                  SSH {username}@{host}:{port}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {status === 'reconnecting' && onReconnectNow && (
                <Button variant="outline" size="sm" onClick={onReconnectNow}>
                  立即重连
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {status === 'reconnecting' || status === 'error' ? '隐藏' : '关闭'}
              </Button>
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="px-4 pb-3">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ease-out ${
                status === 'reconnecting'
                  ? 'bg-gradient-to-r from-amber-500 to-orange-400'
                  : status === 'error'
                    ? 'bg-red-500'
                    : 'bg-gradient-to-r from-blue-500 to-blue-400'
              }`}
              style={{ width: progressWidth }}
            />
          </div>
        </div>

        {/* Status line */}
        <div className="px-4 pb-3 flex items-center gap-2 text-sm text-muted-foreground">
          {status === 'reconnecting' && (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
              <span>
                {reconnectAttempt ? `第 ${reconnectAttempt} 次重连` : '重连中'}
                {remainingMs > 0 ? `，${Math.ceil(remainingMs / 1000)}s 后重试` : '...'}
              </span>
            </>
          )}
          {status === 'error' && (
            <>
              <XCircle className="h-4 w-4 text-red-500" />
              <span>连接已断开</span>
            </>
          )}
          {status === 'connecting' && (
            <>
              <div className="h-4 w-4 border-2 border-muted-foreground/30 border-t-blue-500 rounded-full animate-spin" />
              <span>将在 {remaining}s 后超时</span>
            </>
          )}
          {status === 'connected' && (
            <>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              <span>已连接</span>
            </>
          )}
        </div>

        <Separator />

        {/* Steps log */}
        <div className="p-4 max-h-48 overflow-y-auto">
          <div className="space-y-2">
            {steps.map((step) => (
              <div key={step.id} className="flex items-start gap-2">
                {getStatusIcon(step.status)}
                <div className="flex-1">
                  <span className={`text-sm ${
                    step.status === 'done' ? 'text-muted-foreground' :
                    step.status === 'error' ? 'text-red-500' :
                    step.status === 'active' ? 'text-foreground' :
                    'text-muted-foreground/60'
                  }`}>
                    {step.label}
                  </span>
                  {step.detail && (
                    <p className="text-xs text-muted-foreground mt-0.5">{step.detail}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer: reconnect controls for error/reconnecting states */}
        {(status === 'error' || status === 'reconnecting') && (
          <div className="px-4 pb-4">
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <p className="text-sm text-red-500">{errorMessage || '连接失败'}</p>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              {status === 'error' && onReconnectNow && (
                <Button size="sm" onClick={onReconnectNow}>
                  重新连接
                </Button>
              )}
              {onCancel && (
                <Button size="sm" variant="outline" onClick={onCancel}>
                  关闭标签
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
