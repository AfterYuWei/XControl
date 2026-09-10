import { useEffect, useState } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getAppDiagnostics, type AppDiagnostics } from '@/lib/lifecycle'
import { getPlatformCapabilities } from '@/lib/platform'

const STATE_LABELS = {
  foreground: '前台',
  background: '后台恢复窗口',
  suspended: '已挂起',
} as const

export function MobileDiagnosticsPanel() {
  const [snapshot, setSnapshot] = useState<AppDiagnostics | null>(null)
  const [error, setError] = useState('')

  const refresh = async () => {
    try {
      setSnapshot(await getAppDiagnostics())
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const platform = getPlatformCapabilities().platform
  const rows = snapshot ? [
    ['平台', snapshot.platform],
    ['网络状态', `${snapshot.networkState === 'online' ? '在线' : snapshot.networkState === 'offline' ? '离线' : '未知'} · 世代 ${snapshot.networkGeneration}`],
    ['应用状态', STATE_LABELS[snapshot.state]],
    ['后台窗口', snapshot.state === 'foreground' ? '未启用' : `已用 ${snapshot.backgroundElapsedSeconds}s · 剩余 ${snapshot.remainingSeconds}s`],
    ['活动远程会话', String(snapshot.activeSessions)],
    ['最近断开/重连原因', snapshot.recentReason || '无'],
    ...(platform === 'android' ? [
      ['Android 前台服务', snapshot.androidForegroundService ? '运行中' : '未运行'],
      ['通知权限', snapshot.notificationPermission ? '已授权' : '未授权'],
    ] : []),
    ...(platform === 'ios' ? [[
      'iOS 系统后台时间',
      snapshot.iosBackgroundTimeRemainingSeconds == null
        ? '当前未授予后台任务时间'
        : `${snapshot.iosBackgroundTimeRemainingSeconds}s`,
    ]] : []),
  ] : []

  return (
    <div className="settings-section">
      <div className="settings-section-title">
        <Activity size={14} />
        <span>移动端诊断</span>
      </div>
      {rows.map(([label, value]) => (
        <div className="settings-field" key={label}>
          <div className="settings-field-info"><span className="settings-field-label">{label}</span></div>
          <span className="text-right text-sm text-muted-foreground">{value}</span>
        </div>
      ))}
      {error ? <div className="pf-error">读取诊断状态失败：{error}</div> : null}
      <Button type="button" variant="outline" onClick={() => void refresh()}>
        <RefreshCw size={13} />刷新
      </Button>
      <p className="settings-field-desc">诊断数据不包含密码、私钥或终端输入。</p>
    </div>
  )
}
