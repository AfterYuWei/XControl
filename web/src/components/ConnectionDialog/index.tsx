import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2, ShieldAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { resolveServerIcon } from '@/lib/serverIcons'
import type { ConnectionLogEntry } from '@/types/ws'

interface ConnectionStep {
  id: string
  label: string
  shortLabel: string
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
  currentStage?: string
  logs?: ConnectionLogEntry[]
  errorMessage?: string
  onCancel?: () => void
  reconnectAttempt?: number
  nextRetryAt?: number
  onReconnectNow?: () => void
  hostKeyFingerprint?: string
  knownHostKeyFingerprint?: string
  onConfirmHostKey?: () => void
}

const STAGE_ORDER = [
  'submitting',
  'preparing',
  'credential',
  'hostkey_check',
  'establishing_ssh',
  'starting_shell',
  'ready',
] as const

const STAGE_LABELS: Record<string, string> = {
  submitting: '提交连接请求',
  preparing: '加载连接配置',
  credential: '准备认证信息',
  hostkey_check: '检查主机指纹',
  hostkey_confirm: '等待确认主机指纹',
  establishing_ssh: '建立 SSH 安全通道',
  starting_shell: '启动远程 Shell',
  ready: '终端就绪',
  disconnected: '连接已中断',
}

const STAGE_SHORT_LABELS: Record<string, string> = {
  submitting: '提交',
  preparing: '配置',
  credential: '认证',
  hostkey_check: '指纹',
  hostkey_confirm: '确认',
  establishing_ssh: '通道',
  starting_shell: 'Shell',
  ready: '完成',
  disconnected: '中断',
}

const LOG_LEVEL_CLASS: Record<string, string> = {
  info: 'text-[var(--fg-3)]',
  warn: 'text-[var(--yellow-deep)]',
  error: 'text-[var(--red)]',
}

function stageLabel(stage?: string) {
  return stage ? (STAGE_LABELS[stage] ?? stage) : STAGE_LABELS.submitting
}

function stageShortLabel(stage?: string) {
  return stage ? (STAGE_SHORT_LABELS[stage] ?? stage) : STAGE_SHORT_LABELS.submitting
}

function stageIndex(stage?: string) {
  if (!stage) return 0
  if (stage === 'hostkey_confirm') return STAGE_ORDER.indexOf('hostkey_check')
  const index = STAGE_ORDER.indexOf(stage as typeof STAGE_ORDER[number])
  return index === -1 ? 0 : index
}

function formatLogTime(at: number) {
  if (!at) return '--:--:--'
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

function dotClass(status: ConnectionStep['status']) {
  if (status === 'done') return 'border-[var(--accent)] bg-[var(--accent)] text-white'
  if (status === 'active') return 'border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--accent)]'
  if (status === 'error') return 'border-[var(--red)] bg-[var(--red-bg)] text-[var(--red)]'
  return 'border-[var(--border)] bg-[var(--bg-panel)] text-[var(--fg-4)]'
}

function stepLineClass(status: ConnectionStep['status']) {
  if (status === 'error') return 'bg-[var(--red)]/45'
  if (status === 'done') return 'bg-[var(--accent)]'
  if (status === 'active') return 'bg-[var(--accent)]/40'
  return 'bg-[var(--border)]'
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
  currentStage,
  logs = [],
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
  const logContainerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    setElapsed(0)
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [open, status, currentStage])

  useEffect(() => {
    if (status !== 'connected') return
    const timer = setTimeout(() => onOpenChange(false), 700)
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

  useEffect(() => {
    if (!open) return
    const container = logContainerRef.current
    if (!container) return

    const raf = requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight
    })

    return () => cancelAnimationFrame(raf)
  }, [logs, open])

  const steps = useMemo<ConnectionStep[]>(() => {
    const currentIndex = stageIndex(currentStage)
    const items: ConnectionStep[] = STAGE_ORDER.map((stage) => ({
      id: stage,
      label: stageLabel(stage),
      shortLabel: stageShortLabel(stage),
      status: 'pending',
    }))

    items.forEach((item, index) => {
      if (status === 'connected') {
        item.status = 'done'
        return
      }

      if (index < currentIndex) {
        item.status = 'done'
        return
      }

      if (index === currentIndex) {
        item.status = status === 'error' ? 'error' : 'active'

        if (currentStage === 'hostkey_confirm') {
          item.detail = '检测到主机指纹变更，正在等待你的确认。'
        } else if (status === 'reconnecting') {
          item.detail = errorMessage || '连接中断后，系统正在自动重连。'
        } else if (status === 'error') {
          item.detail = errorMessage
        }
      }
    })

    if (status === 'connected') {
      items[items.length - 1].detail = '远程终端已经可用。'
    }

    if ((status === 'error' || status === 'reconnecting') && currentStage === 'disconnected') {
      items[items.length - 1].status = status === 'error' ? 'error' : 'active'
      items[items.length - 1].detail = errorMessage
    }

    return items
  }, [currentStage, errorMessage, status])

  const currentStep = useMemo(
    () => steps.find((step) => step.status === 'active' || step.status === 'error') ?? steps[steps.length - 1],
    [steps],
  )

  const progressWidth = useMemo(() => {
    if (status === 'connected' || status === 'error') return '100%'

    if (status === 'reconnecting') {
      if (!nextRetryAt || !reconnectAttempt) return '100%'
      const backoff = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]
      const total = backoff[Math.min(reconnectAttempt - 1, backoff.length - 1)] ?? 30000
      const elapsedMs = total - remainingMs
      return `${Math.min(100, (elapsedMs / total) * 100)}%`
    }

    return `${((stageIndex(currentStage) + 1) / STAGE_ORDER.length) * 100}%`
  }, [currentStage, nextRetryAt, reconnectAttempt, remainingMs, status])

  const ServerIcon = resolveServerIcon(icon)
  const isHostKeyStep = status === 'hostkey' || currentStage === 'hostkey_confirm'

  const summaryText =
    status === 'connected'
      ? '连接成功'
      : status === 'error'
        ? '连接失败'
        : status === 'reconnecting'
          ? reconnectAttempt
            ? `第 ${reconnectAttempt} 次自动重连`
            : '正在自动重连'
          : isHostKeyStep
            ? '等待确认主机指纹'
            : `正在连接 · ${elapsed}s`

  const stageText = stageLabel(currentStage)

  if (!open) return null

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center px-4 py-6">
      <div className="absolute inset-0 bg-black/35" onClick={() => onOpenChange(false)} />

      <div
        className="relative z-50 flex h-[560px] w-full max-w-[860px] flex-col overflow-hidden border bg-[var(--bg-panel)] text-[var(--fg)]"
        style={{
          borderColor: 'var(--border)',
          borderRadius: 'var(--r-lg)',
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        <div className="shrink-0 border-b border-[var(--border)] px-4 py-3.5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center border bg-[var(--bg)] text-[var(--fg-2)]"
                style={{ borderColor: 'var(--border)', borderRadius: 'var(--r-sm)' }}
              >
                {isHostKeyStep ? (
                  <ShieldAlert size={17} />
                ) : status === 'reconnecting' || status === 'error' ? (
                  <AlertTriangle size={17} />
                ) : (
                  <ServerIcon size={17} />
                )}
              </div>

              <div className="min-w-0">
                <div className="font-mono text-[11px] uppercase text-[var(--fg-4)]">SSH Session</div>
                <h3 className="truncate text-[15px] font-semibold text-[var(--fg)]">{profileName}</h3>
                <p className="text-[12px] text-[var(--fg-3)]">
                  {username}@{host}:{port}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span
                    className="rounded-full border px-2 py-0.5 text-[11px] text-[var(--fg-3)]"
                    style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg)' }}
                  >
                    {summaryText}
                  </span>
                  <span
                    className="rounded-full border px-2 py-0.5 text-[11px] text-[var(--accent)]"
                    style={{ borderColor: 'var(--border)', backgroundColor: 'var(--accent-bg)' }}
                  >
                    当前阶段：{stageText}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {status === 'reconnecting' && onReconnectNow && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onReconnectNow}
                  className="h-8 rounded-[var(--r-sm)] border-[var(--border)] bg-[var(--bg-panel)] px-3 text-[var(--fg-2)] hover:bg-[var(--bg-elevated)]"
                >
                  立即重连
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
                className="h-8 rounded-[var(--r-sm)] border-[var(--border)] bg-[var(--bg-panel)] px-3 text-[var(--fg-2)] hover:bg-[var(--bg-elevated)]"
              >
                {status === 'connected' ? '关闭' : '隐藏'}
              </Button>
            </div>
          </div>

          <div className="mt-3 h-1 overflow-hidden rounded-full bg-[var(--border-subtle)]">
            <div className="h-full bg-[var(--accent)] transition-all duration-300 ease-out" style={{ width: progressWidth }} />
          </div>
        </div>

        <div className="shrink-0 px-4 py-3.5">
          <div
            className="border bg-[var(--bg)] px-3.5 py-3.5"
            style={{ borderColor: 'var(--border)', borderRadius: 'var(--r-lg)' }}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="font-mono text-[11px] uppercase text-[var(--fg-4)]">Lifecycle</div>
                <h4 className="text-sm font-medium text-[var(--fg)]">连接流程</h4>
              </div>
              <span className="text-[11px] text-[var(--fg-4)]">{steps.length} 个阶段</span>
            </div>

            <div className="overflow-x-auto pb-1">
              <div className="min-w-[680px]">
                <div className="relative grid grid-cols-7 gap-2">
                  {steps.map((step, index) => (
                    <div key={step.id} className="relative flex flex-col items-center text-center">
                      {index < steps.length - 1 && (
                        <div
                          className={`absolute left-[calc(50%+18px)] top-3.5 h-px w-[calc(100%-4px)] ${stepLineClass(step.status)}`}
                        />
                      )}

                      <div
                        className={`relative z-10 flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-medium ${dotClass(step.status)}`}
                      >
                        {step.status === 'done' ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : step.status === 'active' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : step.status === 'error' ? (
                          <X className="h-3.5 w-3.5" />
                        ) : (
                          index + 1
                        )}
                      </div>

                      <div className="mt-2 text-[11px] font-medium text-[var(--fg-2)]">{step.shortLabel}</div>
                      <div className="mt-0.5 max-w-[88px] text-[10px] leading-4 text-[var(--fg-4)]">{step.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div
              className="mt-3.5 border px-3.5 py-2.5"
              style={{ borderColor: 'var(--border)', borderRadius: 'var(--r-lg)', backgroundColor: 'var(--bg-panel)' }}
            >
              <div className="flex items-center gap-2 text-sm">
                {status === 'connected' ? (
                  <Check className="h-4 w-4 text-[var(--accent)]" />
                ) : status === 'error' ? (
                  <X className="h-4 w-4 text-[var(--red)]" />
                ) : isHostKeyStep ? (
                  <ShieldAlert className="h-4 w-4 text-[var(--yellow-deep)]" />
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />
                )}
                <span className="font-medium text-[var(--fg)]">{currentStep?.label || stageText}</span>
                <span className="text-[var(--fg-4)]">·</span>
                <span className="text-[var(--fg-3)]">
                  {status === 'reconnecting' && remainingMs > 0
                    ? `${Math.ceil(remainingMs / 1000)} 秒后再次尝试`
                    : currentStep?.detail || errorMessage || '正在推进连接流程'}
                </span>
              </div>
            </div>

            {isHostKeyStep && (
              <div
                className="mt-3.5 border px-3.5 py-3"
                style={{ borderColor: 'var(--yellow)', borderRadius: 'var(--r-lg)', backgroundColor: 'var(--yellow-bg)' }}
              >
                <div className="flex items-start gap-3">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--yellow-deep)]" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-[var(--fg)]">主机指纹需要确认</div>
                    <div className="mt-1 text-xs leading-5 text-[var(--fg-3)]">
                      当前服务器返回的主机指纹与历史记录不一致。请确认目标主机变更可信后，再继续连接。
                    </div>
                    <div
                      className="mt-3 space-y-2 border p-3"
                      style={{ borderColor: 'var(--border)', borderRadius: 'var(--r-sm)', backgroundColor: 'var(--bg-panel)' }}
                    >
                      {knownHostKeyFingerprint && (
                        <p className="text-sm text-[var(--fg-3)]">
                          历史指纹
                          <span className="ml-2 break-all font-mono text-xs text-[var(--fg-4)]">{knownHostKeyFingerprint}</span>
                        </p>
                      )}
                      <p className="text-sm text-[var(--fg-3)]">
                        当前指纹
                        <span className="ml-2 break-all font-mono text-xs text-[var(--fg-4)]">{hostKeyFingerprint || '未知'}</span>
                      </p>
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex justify-end gap-2">
                  {onCancel && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={onCancel}
                      className="h-8 rounded-[var(--r-sm)] border-[var(--border)] bg-[var(--bg-panel)] px-3 text-[var(--fg-2)] hover:bg-[var(--bg-elevated)]"
                    >
                      取消连接
                    </Button>
                  )}
                  {onConfirmHostKey && (
                    <Button
                      size="sm"
                      onClick={onConfirmHostKey}
                      className="h-8 rounded-[var(--r-sm)] bg-[var(--fg-2)] px-3 text-white hover:bg-[var(--fg)]"
                    >
                      信任并继续
                    </Button>
                  )}
                </div>
              </div>
            )}

            {(status === 'error' || status === 'reconnecting') && errorMessage && (
              <div
                className="mt-3.5 border px-3.5 py-3"
                style={{ borderColor: 'var(--red)', borderRadius: 'var(--r-lg)', backgroundColor: 'var(--red-bg)' }}
              >
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--red)]" />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-[var(--fg)]">
                      {status === 'reconnecting' ? '连接已中断，正在恢复' : '连接失败'}
                    </div>
                    <p className="mt-1 text-sm text-[var(--fg-3)]">{errorMessage}</p>
                  </div>
                </div>

                <div className="mt-3 flex justify-end gap-2">
                  {status === 'error' && onReconnectNow && (
                    <Button
                      size="sm"
                      onClick={onReconnectNow}
                      className="h-8 rounded-[var(--r-sm)] bg-[var(--fg-2)] px-3 text-white hover:bg-[var(--fg)]"
                    >
                      重新连接
                    </Button>
                  )}
                  {onCancel && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={onCancel}
                      className="h-8 rounded-[var(--r-sm)] border-[var(--border)] bg-[var(--bg-panel)] px-3 text-[var(--fg-2)] hover:bg-[var(--bg-elevated)]"
                    >
                      关闭标签
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <Separator className="shrink-0 bg-[var(--border)]" />

        <div className="flex min-h-0 flex-1 flex-col px-4 py-3.5">
          <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
            <div>
              <div className="font-mono text-[11px] uppercase text-[var(--fg-4)]">Logs</div>
              <h4 className="text-sm font-medium text-[var(--fg)]">实时日志</h4>
            </div>
            <span className="text-[11px] text-[var(--fg-4)]">{logs.length} 条记录</span>
          </div>

          <div
            ref={logContainerRef}
            className="min-h-0 flex-1 overflow-y-auto border bg-[var(--bg)]"
            style={{ borderColor: 'var(--border)', borderRadius: 'var(--r-lg)' }}
          >
            {logs.length === 0 ? (
              <div className="p-4 text-sm text-[var(--fg-4)]">正在等待后端返回连接日志…</div>
            ) : (
              <div className="divide-y divide-[var(--border)]">
                {logs.map((log, index) => (
                  <div key={`${log.at}-${index}`} className="px-4 py-2.5">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--fg-4)]">
                      <span>{formatLogTime(log.at)}</span>
                      <span>{stageLabel(log.stage)}</span>
                      <span className={`font-medium ${LOG_LEVEL_CLASS[log.level] ?? 'text-[var(--fg-4)]'}`}>
                        {log.level.toUpperCase()}
                      </span>
                    </div>
                    <p className={`text-sm leading-5 ${LOG_LEVEL_CLASS[log.level] ?? 'text-[var(--fg-3)]'}`}>{log.message}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
