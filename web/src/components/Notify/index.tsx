import { useEffect } from 'react'
import { XCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { useNotifyStore, type NotificationItem, type NotifyType } from '@/store/notify'

// 类型 → 图标 + 语义色变量(遵循 DESIGN.md: error=red, warning=yellow, success=green, info=accent)
const TYPE_META: Record<NotifyType, { icon: typeof XCircle; color: string }> = {
  error:   { icon: XCircle,       color: 'var(--red)' },
  warning: { icon: AlertTriangle, color: 'var(--yellow)' },
  success: { icon: CheckCircle2,  color: 'var(--green)' },
  info:    { icon: Info,          color: 'var(--accent)' },
}

function NotifyCard({ item }: { item: NotificationItem }) {
  const dismiss = useNotifyStore((s) => s.dismiss)
  const meta = TYPE_META[item.type]
  const Icon = meta.icon

  // 自动关闭:每条独立计时,互不影响
  useEffect(() => {
    if (item.duration <= 0) return
    const t = setTimeout(() => dismiss(item.id), item.duration)
    return () => clearTimeout(t)
  }, [item.id, item.duration, dismiss])

  return (
    <div className={`xctrl-notify-card xctrl-notify-${item.type}`} role="alert">
      {/* 左侧语义色条 */}
      <span className="xctrl-notify-bar" style={{ background: meta.color }} />
      <Icon size={16} className="xctrl-notify-icon" style={{ color: meta.color }} />
      <div className="xctrl-notify-body">
        {item.title && <div className="xctrl-notify-title">{item.title}</div>}
        <div className="xctrl-notify-msg">{item.message}</div>
      </div>
      <button
        className="xctrl-notify-close"
        aria-label="关闭"
        onClick={() => dismiss(item.id)}
      >
        <X size={14} />
      </button>
    </div>
  )
}

export function Notify() {
  const notifications = useNotifyStore((s) => s.notifications)
  return (
    <div className="xctrl-notify-root" aria-live="polite">
      {notifications.map((n) => (
        <NotifyCard key={n.id} item={n} />
      ))}
    </div>
  )
}
