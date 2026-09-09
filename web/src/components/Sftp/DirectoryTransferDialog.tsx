import { Archive, FolderInput, X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useSftpStore } from './storeContext'

export function DirectoryTransferDialog() {
  const pending = useSftpStore((state) => state.pendingDirectoryDrop)
  const resolve = useSftpStore((state) => state.resolveDirectoryDrop)
  if (!pending) return null

  const count = pending.drag.entries.filter((entry) => entry.is_dir).length
  const destination = `${pending.target.serverName}:${pending.target.destDir}`
  return (
    <Dialog open onOpenChange={(open) => !open && resolve(null)}>
      <DialogContent showCloseButton={false} className="w-auto max-w-none gap-0 p-0">
        <DialogTitle className="sr-only">选择文件夹传输方式</DialogTitle>
        <div className="sftp-dir-mode">
        <div className="sftp-conflict-hdr">
          <FolderInput size={16} />
          <span className="sftp-conflict-title">选择文件夹传输方式</span>
          <Button type="button" variant="ghost" size="icon-xs" className="sftp-picker-x" onClick={() => resolve(null)} aria-label="关闭">
            <X size={15} />
          </Button>
        </div>
        <p>将 {count} 个文件夹传输到 <strong title={destination}>{destination}</strong></p>
        <div className="sftp-dir-mode-actions">
          <Button type="button" className="sftp-dir-mode-card primary" onClick={() => resolve('preserve')}>
            <FolderInput size={20} />
            <span>保留目录结构</span>
            <small>在目标位置创建同名文件夹并递归复制内容</small>
          </Button>
          <Button type="button" variant="outline" className="sftp-dir-mode-card" onClick={() => resolve('archive')}>
            <Archive size={20} />
            <span>压缩为 .tar.gz</span>
            <small>每个文件夹生成一个压缩包，普通文件保持不变</small>
          </Button>
        </div>
        <Button type="button" variant="ghost" className="sftp-conflict-btn ghost" onClick={() => resolve(null)}>取消</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
