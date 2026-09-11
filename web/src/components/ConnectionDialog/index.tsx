import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  Loader2,
  ShieldAlert,
  SquareTerminal,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { writeClipboardText } from '@/lib/clipboard'
import { ServerIcon } from '@/lib/serverIcons'
import { cn } from '@/lib/utils'
import type { ConnectionLogEntry } from '@/types/sessionMessage'
import '@/styles/connection-dialog.css'

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
  onHostKeyDecision?: (decision: 'trust_once' | 'trust_permanently' | 'reject') => void
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
  info: 'connection-log-info',
  warn: 'connection-log-warn',
  error: 'connection-log-error',
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
  onHostKeyDecision,
}: ConnectionDialogProps) {
  const [elapsed, setElapsed] = useState(0)
  const [remainingMs, setRemainingMs] = useState(0)
  const [logsExpanded, setLogsExpanded] = useState(status === 'error')
  const [copiedFingerprint, setCopiedFingerprint] = useState<'known' | 'current' | null>(null)
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
    if (status === 'error') setLogsExpanded(true)
  }, [status])

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
    if (!open || !logsExpanded) return
    const container = logContainerRef.current
    if (!container) return

    const raf = requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight
    })

    return () => cancelAnimationFrame(raf)
  }, [logs, logsExpanded, open])

  useEffect(() => {
    if (!copiedFingerprint) return
    const timer = setTimeout(() => setCopiedFingerprint(null), 1800)
    return () => clearTimeout(timer)
  }, [copiedFingerprint])

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
          item.detail = '请核对服务器主机指纹后决定是否继续。'
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
      items[items.length - 1].label = stageLabel('disconnected')
      items[items.length - 1].shortLabel = stageShortLabel('disconnected')
      items[items.length - 1].detail = errorMessage
    }

    return items
  }, [currentStage, errorMessage, status])

  const currentStep = useMemo(
    () => steps.find((step) => step.status === 'active' || step.status === 'error') ?? steps[steps.length - 1],
    [steps],
  )

  const isHostKeyStep = status === 'hostkey' || currentStage === 'hostkey_confirm'
  const isChangedHostKey = isHostKeyStep && Boolean(knownHostKeyFingerprint)
  const activeStepIndex = steps.findIndex((step) => step.status === 'active' || step.status === 'error')
  const currentStepNumber = status === 'connected' ? steps.length : Math.max(0, activeStepIndex) + 1
  const latestLog = logs.at(-1)?.message

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
            ? '等待安全确认'
            : `正在连接 · ${elapsed}s`

  const focusTitle =
    status === 'connected'
      ? '连接成功'
      : status === 'error'
        ? currentStage === 'disconnected'
          ? '连接已中断'
          : currentStep?.label || '连接失败'
        : status === 'reconnecting'
          ? summaryText
          : isHostKeyStep
            ? isChangedHostKey
              ? '服务器主机指纹已发生变化'
              : '首次连接，需要验证主机身份'
            : `正在${currentStep?.label || stageLabel(currentStage)}`

  const focusDetail =
    status === 'reconnecting' && remainingMs > 0
      ? `${Math.ceil(remainingMs / 1000)} 秒后再次尝试`
      : currentStep?.detail || errorMessage || latestLog || '正在推进连接流程'

  const canCloseByClick = status !== 'connecting' && status !== 'reconnecting' && status !== 'hostkey'

  const copyFingerprint = async (kind: 'known' | 'current', value?: string) => {
    if (!value) return
    try {
      await writeClipboardText(value)
      setCopiedFingerprint(kind)
    } catch {
      setCopiedFingerprint(null)
    }
  }

  if (!open) return null

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && canCloseByClick) onOpenChange(false)
      }}
    >
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => !canCloseByClick && event.preventDefault()}
        onPointerDownOutside={(event) => !canCloseByClick && event.preventDefault()}
        className="connection-dialog"
        data-status={status}
        data-host-key-change={isChangedHostKey ? 'true' : 'false'}
      >
        <DialogTitle className="sr-only">{focusTitle}</DialogTitle>

        <header className="connection-dialog-header">
          <div className="connection-server-icon" aria-hidden="true">
            {isHostKeyStep ? (
              <ShieldAlert />
            ) : status === 'reconnecting' || status === 'error' ? (
              <AlertTriangle />
            ) : (
              <ServerIcon iconKey={icon} size={17} />
            )}
          </div>

          <div className="connection-server-identity">
            <span>SSH SESSION</span>
            <strong>{profileName}</strong>
            <small>
              {username}@{host}:{port}
            </small>
          </div>

          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} className="connection-hide-button">
            {status === 'connected' ? '关闭' : '隐藏'}
          </Button>
        </header>

        <main className="connection-dialog-main">
          <section className="connection-current-stage" aria-live="polite">
            <div className="connection-stage-indicator" aria-hidden="true">
              {status === 'connected' ? (
                <Check />
              ) : status === 'error' ? (
                <X />
              ) : isHostKeyStep ? (
                <ShieldAlert />
              ) : (
                <Loader2 className="connection-spin" />
              )}
            </div>
            <div className="connection-current-copy">
              <strong>{focusTitle}</strong>
              <span>{focusDetail}</span>
            </div>
            <span className="connection-elapsed">{isHostKeyStep ? `${currentStepNumber}/${steps.length}` : summaryText}</span>
          </section>

          <section className="connection-steps" aria-label={`连接进度：第 ${currentStepNumber} 步，共 ${steps.length} 步`}>
            <div className="connection-step-rail">
              {steps.map((step, index) => (
                <div className="connection-step-segment" key={step.id}>
                  <div className={cn('connection-step-node', `is-${step.status}`)} aria-current={step.status === 'active' ? 'step' : undefined}>
                    {step.status === 'done' ? (
                      <Check />
                    ) : step.status === 'active' ? (
                      <Loader2 className="connection-spin" />
                    ) : step.status === 'error' ? (
                      <X />
                    ) : (
                      index + 1
                    )}
                  </div>
                  {index < steps.length - 1 && <div className={cn('connection-step-line', `is-${step.status}`)} />}
                </div>
              ))}
            </div>
            <div className="connection-step-labels" aria-hidden="true">
              {steps.map((step) => (
                <span className={cn(step.status === 'active' && 'is-active', step.status === 'error' && 'is-error')} key={step.id}>
                  {step.shortLabel}
                </span>
              ))}
            </div>
          </section>

          {isHostKeyStep && (
            <section className={cn('connection-host-key', isChangedHostKey ? 'is-changed' : 'is-first')} role="alert">
              <div className="connection-security-heading">
                {isChangedHostKey ? <AlertTriangle aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
                <div>
                  <strong>{isChangedHostKey ? '主机指纹与历史记录不一致' : '确认这台服务器的主机指纹'}</strong>
                  <p>
                    {isChangedHostKey
                      ? '这可能是服务器重装或密钥轮换，也可能存在中间人攻击。请先通过可信渠道核对新指纹。'
                      : '这是首次连接这台服务器。请通过可信渠道核对指纹，确认目标服务器身份。'}
                  </p>
                </div>
              </div>

              <div className={cn('connection-fingerprint-grid', !isChangedHostKey && 'is-single')}>
                {knownHostKeyFingerprint && (
                  <div className="connection-fingerprint is-known">
                    <div>
                      <span>历史指纹</span>
                      <small>上次保存</small>
                    </div>
                    <code>{knownHostKeyFingerprint}</code>
                    <button type="button" onClick={() => void copyFingerprint('known', knownHostKeyFingerprint)} aria-label="复制历史指纹">
                      {copiedFingerprint === 'known' ? <Check /> : <Copy />}
                    </button>
                  </div>
                )}
                <div className="connection-fingerprint is-current">
                  <div>
                    <span>{isChangedHostKey ? '当前指纹' : '服务器指纹'}</span>
                    <small>{isChangedHostKey ? '本次返回' : 'SHA-256'}</small>
                  </div>
                  <code>{hostKeyFingerprint || '未知'}</code>
                  <button type="button" onClick={() => void copyFingerprint('current', hostKeyFingerprint)} disabled={!hostKeyFingerprint} aria-label="复制当前指纹">
                    {copiedFingerprint === 'current' ? <Check /> : <Copy />}
                  </button>
                </div>
              </div>

              <div className="connection-host-key-actions">
                {onHostKeyDecision && (
                  <Button
                    size="sm"
                    variant={isChangedHostKey ? 'destructive' : 'outline'}
                    onClick={() => onHostKeyDecision('reject')}
                    className="connection-security-action"
                  >
                    {isChangedHostKey ? '拒绝并断开' : '取消连接'}
                  </Button>
                )}
                {onHostKeyDecision && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onHostKeyDecision('trust_once')}
                    className="connection-security-action"
                  >
                    仅本次信任
                  </Button>
                )}
                {onHostKeyDecision && (
                  <Button
                    size="sm"
                    variant={isChangedHostKey ? 'outline' : 'default'}
                    onClick={() => onHostKeyDecision('trust_permanently')}
                    className="connection-security-action"
                  >
                    {isChangedHostKey ? '更新指纹并继续' : '信任并继续'}
                  </Button>
                )}
              </div>
            </section>
          )}

          {(status === 'error' || status === 'reconnecting') && errorMessage && (
            <section className={cn('connection-error-panel', status === 'reconnecting' && 'is-reconnecting')} role="alert">
              <AlertTriangle aria-hidden="true" />
              <div>
                <strong>{status === 'reconnecting' ? '连接已中断，正在恢复' : '连接失败'}</strong>
                <p>{errorMessage}</p>
              </div>
              <div className="connection-error-actions">
                {onReconnectNow && (
                  <Button size="sm" onClick={onReconnectNow} variant={status === 'error' ? 'default' : 'outline'}>
                    {status === 'error' ? '重新连接' : '立即重连'}
                  </Button>
                )}
                {onCancel && (
                  <Button size="sm" variant="outline" onClick={onCancel}>
                    关闭标签
                  </Button>
                )}
              </div>
            </section>
          )}
        </main>

        <footer className="connection-logs-section">
          <button
            type="button"
            className="connection-logs-toggle"
            onClick={() => setLogsExpanded((value) => !value)}
            aria-expanded={logsExpanded}
            aria-controls="connection-live-logs"
          >
            <SquareTerminal aria-hidden="true" />
            <span>连接日志</span>
            <em>{logs.length}</em>
            {!logsExpanded && latestLog && <small>{latestLog}</small>}
            <ChevronDown className="connection-logs-chevron" aria-hidden="true" />
          </button>

          {logsExpanded && (
            <div id="connection-live-logs" ref={logContainerRef} className="connection-live-logs" aria-live="polite">
              {logs.length === 0 ? (
                <div className="connection-log-empty">正在等待后端返回连接日志…</div>
              ) : (
                logs.map((log, index) => (
                  <div className="connection-log-entry" key={`${log.at}-${index}`}>
                    <div>
                      <time>{formatLogTime(log.at)}</time>
                      <span>{stageLabel(log.stage)}</span>
                      <b className={LOG_LEVEL_CLASS[log.level] ?? 'connection-log-info'}>{log.level.toUpperCase()}</b>
                    </div>
                    <p className={LOG_LEVEL_CLASS[log.level] ?? 'connection-log-info'}>{log.message}</p>
                  </div>
                ))
              )}
            </div>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  )
}
