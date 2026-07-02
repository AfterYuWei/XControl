import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, ShieldAlert, XCircle } from 'lucide-react'
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
  status: 'connecting' | 'connected' | 'error' | 'reconnecting' | 'hostkey'
  errorMessage?: string
  onCancel?: () => void
  reconnectAttempt?: number
  nextRetryAt?: number
  onReconnectNow?: () => void
  hostKeyFingerprint?: string
  knownHostKeyFingerprint?: string
  onConfirmHostKey?: () => void
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
  hostKeyFingerprint,
  knownHostKeyFingerprint,
  onConfirmHostKey,
}: ConnectionDialogProps) {
  const [elapsed, setElapsed] = useState(0)
  const [remainingMs, setRemainingMs] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (status !== 'connected') return
    const timer = setTimeout(() => onOpenChange(false), 500)
    return () => clearTimeout(timer)
  }, [status, onOpenChange])

  useEffect(() => {
    if (status !== 'reconnecting' || !nextRetryAt) {
      setRemainingMs(0)
      return
    }
    const update = () => setRemainingMs(Math.max(0, nextRetryAt - Date.now()))
    update()
    const timer = setInterval(update, 100)
    return () => clearInterval(timer)
  }, [status, nextRetryAt])

  if (!open) return null

  const ServerIcon = resolveServerIcon(icon)
  const timeout = 120
  const remaining = Math.max(0, timeout - elapsed)

  const backoffForAttempt = (n: number): number => {
    const table = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]
    return table[Math.min(n - 1, table.length - 1)] || 30000
  }

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

  const steps: ConnectionStep[] = (() => {
    if (status === 'hostkey') {
      return [
        {
          id: 'hostkey-check',
          label: '检测到主机指纹变化',
          status: 'error',
          detail: '请确认是否继续连接，避免连接到错误的服务器。',
        },
      ]
    }
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
    if (status === 'error') {
      return [
        { id: 'disconnect', label: '连接失败', status: 'error', detail: errorMessage },
      ]
    }
    if (status === 'connected') {
      return [
        { id: 'init', label: '初始化安全通道', status: 'done' },
        { id: 'resolve', label: `解析主机 ${host}`, status: 'done' },
        { id: 'connect', label: `连接到 ${host}:${port}`, status: 'done' },
        { id: 'auth', label: 'SSH 认证', status: 'done' },
        { id: 'shell', label: '启动 Shell', status: 'done' },
      ]
    }

    const baseSteps: ConnectionStep[] = [
      { id: 'init', label: '初始化安全通道', status: 'pending' },
      { id: 'resolve', label: `解析主机 ${host}`, status: 'pending' },
      { id: 'connect', label: `连接到 ${host}:${port}`, status: 'pending' },
      { id: 'auth', label: 'SSH 认证', status: 'pending' },
      { id: 'shell', label: '启动 Shell', status: 'pending' },
    ]
    const activeIndex = elapsed >= 2 ? 3 : elapsed >= 1 ? 2 : 1
    if (errorMessage) {
      return baseSteps.map((step, index) => {
        if (index < activeIndex) return { ...step, status: 'done' as const }
        if (index === activeIndex) return { ...step, status: 'error' as const, detail: errorMessage }
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

  const progressWidth = (() => {
    if (status === 'connected') return '100%'
    if (status === 'error' || status === 'hostkey') return '100%'
    if (status === 'reconnecting') {
      if (!nextRetryAt || !reconnectAttempt) return '100%'
      const total = backoffForAttempt(reconnectAttempt)
      const elapsedMs = total - remainingMs
      return `${Math.min(100, (elapsedMs / total) * 100)}%`
    }
    return `${Math.min(80, (elapsed / timeout) * 100)}%`
  })()

  const headerGradient =
    status === 'reconnecting' || status === 'error' || status === 'hostkey'
      ? 'from-amber-500 to-orange-600'
      : 'from-blue-500 to-blue-600'

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => onOpenChange(false)} />
      <div className="relative z-50 w-full max-w-md bg-background rounded-xl shadow-modal overflow-hidden">
        <div className="p-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className={`h-10 w-10 rounded-lg bg-gradient-to-br ${headerGradient} flex items-center justify-center text-white`}>
                {status === 'hostkey' ? (
                  <ShieldAlert size={20} />
                ) : status === 'reconnecting' || status === 'error' ? (
                  <AlertTriangle size={20} />
                ) : (
                  <ServerIcon size={20} />
                )}
              </div>
              <div>
                <h3 className="font-semibold text-base">{profileName}</h3>
                <p className="text-sm text-muted-foreground">SSH {username}@{host}:{port}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {status === 'reconnecting' && onReconnectNow && (
                <Button variant="outline" size="sm" onClick={onReconnectNow}>
                  立即重连
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {status === 'reconnecting' || status === 'error' || status === 'hostkey' ? '隐藏' : '关闭'}
              </Button>
            </div>
          </div>
        </div>

        <div className="px-4 pb-3">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ease-out ${
                status === 'reconnecting'
                  ? 'bg-gradient-to-r from-amber-500 to-orange-400'
                  : status === 'error' || status === 'hostkey'
                    ? 'bg-amber-500'
                    : 'bg-gradient-to-r from-blue-500 to-blue-400'
              }`}
              style={{ width: progressWidth }}
            />
          </div>
        </div>

        <div className="px-4 pb-3 flex items-center gap-2 text-sm text-muted-foreground">
          {status === 'hostkey' && (
            <>
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              <span>服务器主机指纹发生变化，请确认后继续连接</span>
            </>
          )}
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
              <span>连接失败</span>
            </>
          )}
          {status === 'connecting' && (
            <>
              <div className="h-4 w-4 border-2 border-muted-foreground/30 border-t-blue-500 rounded-full animate-spin" />
              <span>{remaining}s 后超时</span>
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

        <div className="p-4 max-h-48 overflow-y-auto">
          <div className="space-y-2">
            {steps.map((step) => (
              <div key={step.id} className="flex items-start gap-2">
                {getStatusIcon(step.status)}
                <div className="flex-1">
                  <span
                    className={`text-sm ${
                      step.status === 'done'
                        ? 'text-muted-foreground'
                        : step.status === 'error'
                          ? 'text-red-500'
                          : step.status === 'active'
                            ? 'text-foreground'
                            : 'text-muted-foreground/60'
                    }`}
                  >
                    {step.label}
                  </span>
                  {step.detail && <p className="text-xs text-muted-foreground mt-0.5">{step.detail}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {status === 'hostkey' && (
          <div className="px-4 pb-4">
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 space-y-2">
              {knownHostKeyFingerprint && (
                <p className="text-sm">
                  旧指纹:
                  <span className="ml-2 font-mono text-xs break-all">{knownHostKeyFingerprint}</span>
                </p>
              )}
              <p className="text-sm">
                当前指纹:
                <span className="ml-2 font-mono text-xs break-all">{hostKeyFingerprint || '未知'}</span>
              </p>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              {onCancel && (
                <Button size="sm" variant="outline" onClick={onCancel}>
                  取消连接
                </Button>
              )}
              {onConfirmHostKey && (
                <Button size="sm" onClick={onConfirmHostKey}>
                  继续连接
                </Button>
              )}
            </div>
          </div>
        )}

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
