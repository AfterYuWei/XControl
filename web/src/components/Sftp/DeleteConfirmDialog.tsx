import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Folder, FileText, AlertTriangle } from 'lucide-react'
import type { SftpEntry } from '@/types/sftp'

export interface DeleteConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  entries: SftpEntry[]
  onConfirm: () => void | Promise<void>
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  entries,
  onConfirm,
}: DeleteConfirmDialogProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = async () => {
    setLoading(true)
    setError(null)

    try {
      await onConfirm()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setLoading(false)
    }
  }

  const fileCount = entries.filter((e) => !e.is_dir).length
  const dirCount = entries.filter((e) => e.is_dir).length

  const summary = []
  if (fileCount > 0) summary.push(`${fileCount} 个文件`)
  if (dirCount > 0) summary.push(`${dirCount} 个文件夹`)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            确认删除
          </DialogTitle>
        </DialogHeader>

        <div className="py-4">
          <p className="text-sm text-muted-foreground mb-3">
            确定要删除以下 {summary.join('和')} 吗？此操作无法撤销。
          </p>

          <div className="max-h-[300px] overflow-y-auto border rounded-md p-2 space-y-1">
            {entries.map((entry) => (
              <div
                key={entry.path}
                className="flex items-center gap-2 px-2 py-1 text-sm rounded hover:bg-muted"
              >
                {entry.is_dir ? (
                  <Folder className="h-4 w-4 text-blue-500 flex-shrink-0" />
                ) : (
                  <FileText className="h-4 w-4 text-gray-500 flex-shrink-0" />
                )}
                <span className="truncate">{entry.name}</span>
                {!entry.is_dir && entry.size > 0 && (
                  <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">
                    {formatSize(entry.size)}
                  </span>
                )}
              </div>
            ))}
          </div>

          {error && (
            <p className="text-sm text-destructive mt-3">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading ? '删除中...' : '确认删除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}
