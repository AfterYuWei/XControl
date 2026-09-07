import { Progress } from '@/components/ui/progress'
import type { UpdateDownloadProgress } from '@/lib/updater'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unit
  return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${units[unit]}`
}

export function UpdateProgressDetails({ progress }: { progress: UpdateDownloadProgress }) {
  const percent = progress.percent ?? 0
  const size = progress.totalBytes
    ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`
    : formatBytes(progress.downloadedBytes)
  const speed = progress.bytesPerSecond > 0
    ? `${formatBytes(progress.bytesPerSecond)}/s`
    : '正在计算速度…'
  const downloaded = progress.percent === null
    ? size
    : `${Math.round(progress.percent)}% · ${size}`

  return (
    <div className="mt-2 w-[280px] space-y-2.5">
      <Progress value={progress.percent} />
      <div className="flex items-center justify-between gap-4 text-xs tabular-nums text-fg-2">
        <span>{progress.phase === 'installing' ? '下载完成' : downloaded}</span>
        <span className="shrink-0 font-medium text-fg-1">
          {progress.phase === 'installing' ? '正在准备安装…' : speed}
        </span>
      </div>
      <span className="sr-only">下载进度 {Math.round(percent)}%</span>
    </div>
  )
}
