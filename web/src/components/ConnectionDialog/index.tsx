import { useEffect, useState } from 'react'
import { Loader2, CheckCircle2, XCircle } from 'lucide-react'
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
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (status !== 'connected') return
    const timer = setTimeout(() => onOpenChange(false), 500)
    return () => clearTimeout(timer)
  }, [status, onOpenChange])

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

  const steps: ConnectionStep[] = (() => {
    const baseSteps: ConnectionStep[] = [
      { id: 'init', label: '初始化安全通道', status: 'pending' },
      { id: 'resolve', label: `解析主机 ${host}`, status: 'pending' },
      { id: 'connect', label: `连接到 ${host}:${port}`, status: 'pending' },
      { id: 'auth', label: 'SSH 认证', status: 'pending' },
      { id: 'shell', label: '启动 Shell', status: 'pending' },
    ]

    if (status === 'connected') {
      return baseSteps.map((step) => ({ ...step, status: 'done' as const }))
    }

    if (status === 'error') {
      const activeIndex = elapsed >= 2 ? 3 : elapsed >= 1 ? 2 : 1
      return baseSteps.map((step, i) => {
        if (i < activeIndex) return { ...step, status: 'done' as const }
        if (i === activeIndex) return { ...step, status: 'error' as const, detail: errorMessage }
        return step
      })
    }

    // status === 'connecting'
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

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => onOpenChange(false)} />
      <div className="relative z-50 w-full max-w-md bg-background rounded-xl shadow-modal overflow-hidden">
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
