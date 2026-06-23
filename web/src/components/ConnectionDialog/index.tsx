import { useEffect, useState } from 'react'
import { X, Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

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
  status: 'connecting' | 'connected' | 'error'
  errorMessage?: string
  onCancel?: () => void
}

export function ConnectionDialog({
  open,
  onOpenChange,
  profileName,
  host,
  port,
  username,
  status,
  errorMessage,
  onCancel,
}: ConnectionDialogProps) {
  const [steps, setSteps] = useState<ConnectionStep[]>([
    { id: 'init', label: '初始化安全通道', status: 'pending' },
    { id: 'resolve', label: `解析主机 ${host}`, status: 'pending' },
    { id: 'connect', label: `连接到 ${host}:${port}`, status: 'pending' },
    { id: 'auth', label: 'SSH 认证', status: 'pending' },
    { id: 'shell', label: '启动 Shell', status: 'pending' },
  ])

  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!open) return
    setElapsed(0)
    setSteps([
      { id: 'init', label: '初始化安全通道', status: 'active' },
      { id: 'resolve', label: `解析主机 ${host}`, status: 'pending' },
      { id: 'connect', label: `连接到 ${host}:${port}`, status: 'pending' },
      { id: 'auth', label: 'SSH 认证', status: 'pending' },
      { id: 'shell', label: '启动 Shell', status: 'pending' },
    ])

    const timer = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(timer)
  }, [open, host, port])

  useEffect(() => {
    if (status === 'connecting') {
      setSteps((prev) =>
        prev.map((step, i) => {
          if (i === 0) return { ...step, status: 'done' }
          if (i === 1) return { ...step, status: 'active' }
          return step
        })
      )

      const t1 = setTimeout(() => {
        setSteps((prev) =>
          prev.map((step, i) => {
            if (i === 1) return { ...step, status: 'done' }
            if (i === 2) return { ...step, status: 'active' }
            return step
          })
        )
      }, 500)

      const t2 = setTimeout(() => {
        setSteps((prev) =>
          prev.map((step, i) => {
            if (i === 2) return { ...step, status: 'done' }
            if (i === 3) return { ...step, status: 'active' }
            return step
          })
        )
      }, 1000)

      return () => {
        clearTimeout(t1)
        clearTimeout(t2)
      }
    }

    if (status === 'connected') {
      setSteps((prev) =>
        prev.map((step) => ({ ...step, status: 'done' }))
      )
      setTimeout(() => onOpenChange(false), 500)
    }

    if (status === 'error') {
      setSteps((prev) =>
        prev.map((step, i) => {
          if (step.status === 'active') {
            return { ...step, status: 'error', detail: errorMessage }
          }
          return step
        })
      )
    }
  }, [status, errorMessage, onOpenChange])

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

  const timeout = 120
  const remaining = Math.max(0, timeout - elapsed)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => onOpenChange(false)} />
      <div className="relative z-50 w-full max-w-md bg-background border border-border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white font-bold text-lg">
                {profileName.charAt(0).toUpperCase()}
              </div>
              <div>
                <h3 className="font-semibold text-base">{profileName}</h3>
                <p className="text-sm text-muted-foreground">
                  SSH {username}@{host}:{port}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={onCancel}>
                隐藏日志
              </Button>
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="px-4 pb-3">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-blue-400 transition-all duration-500 ease-out"
              style={{
                width: status === 'connected' ? '100%' :
                       status === 'error' ? '60%' :
                       `${Math.min(80, (elapsed / timeout) * 100)}%`
              }}
            />
          </div>
        </div>

        {/* Timeout */}
        <div className="px-4 pb-3 flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 border-2 border-muted-foreground/30 border-t-blue-500 rounded-full animate-spin" />
          <span>将在 {remaining}s 后超时</span>
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

        {/* Error footer */}
        {status === 'error' && (
          <div className="px-4 pb-4">
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <p className="text-sm text-red-500">{errorMessage || '连接失败'}</p>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" onClick={onCancel}>
                重试
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
