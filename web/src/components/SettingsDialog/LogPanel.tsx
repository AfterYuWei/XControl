import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Clipboard, FileText, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from 'sonner'
import { writeClipboardText } from '@/lib/clipboard'

type LogKind = 'frontend' | 'backend'

interface LogSnapshot {
  kind: LogKind
  path: string
  content: string
}

export function LogPanel() {
  const [kind, setKind] = useState<LogKind>('frontend')
  const [snapshot, setSnapshot] = useState<LogSnapshot | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      setSnapshot(await invoke<LogSnapshot>('read_app_log', { kind }))
    } catch (error) {
      if (!quiet) toast.error('读取日志失败', { description: String(error) })
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [kind])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(true), 2_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const clear = async () => {
    try {
      await invoke('clear_app_log', { kind })
      await refresh()
      toast.success('日志已清空')
    } catch (error) {
      toast.error('清空日志失败', { description: String(error) })
    }
  }

  const copy = async () => {
    await writeClipboardText(snapshot?.content ?? '')
    toast.success('日志已复制')
  }

  return (
    <div className="settings-section log-panel">
      <div className="settings-section-title">
        <FileText size={14} />
        <span>调试日志（DEBUG）</span>
      </div>

      <div className="log-toolbar">
        <Tabs value={kind} onValueChange={(value) => setKind(value as LogKind)}>
          <TabsList className="log-kind-switch" aria-label="日志类型">
          <TabsTrigger value="frontend">
            前端日志
          </TabsTrigger>
          <TabsTrigger value="backend">
            后端日志
          </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="log-actions">
          <Button variant="outline" size="sm" onClick={() => void copy()} disabled={!snapshot?.content}>
            <Clipboard size={13} />复制
          </Button>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />刷新
          </Button>
          <Button variant="outline" size="sm" onClick={() => void clear()}>
            <Trash2 size={13} />清空
          </Button>
        </div>
      </div>

      <div className="log-path" title={snapshot?.path}>{snapshot?.path ?? '正在读取…'}</div>
      <pre className="log-viewer">{snapshot?.content || '暂无日志'}</pre>
      <div className="settings-field-desc">每 2 秒自动刷新，仅显示文件末尾最多 2 MiB；请求日志会移除 URL 查询参数。</div>
    </div>
  )
}
