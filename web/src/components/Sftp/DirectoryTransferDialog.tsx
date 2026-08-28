import { Archive, FolderInput, X } from 'lucide-react'
import { Dialog } from '@/components/ui/dialog'
import { useSftpStore } from './storeContext'

export function DirectoryTransferDialog() {
  const pending = useSftpStore((state) => state.pendingDirectoryDrop)
  const resolve = useSftpStore((state) => state.resolveDirectoryDrop)
  if (!pending) return null

  const count = pending.drag.entries.filter((entry) => entry.is_dir).length
  const destination = `${pending.target.serverName}:${pending.target.destDir}`
  return (
    <Dialog open onOpenChange={(open) => !open && resolve(null)}>
      <div className="sftp-dir-mode">
        <div className="sftp-conflict-hdr">
          <FolderInput size={16} />
          <span className="sftp-conflict-title">选择文件夹传输方式</span>
          <button className="sftp-picker-x" onClick={() => resolve(null)} aria-label="关闭">
            <X size={15} />
          </button>
        </div>
        <p>将 {count} 个文件夹传输到 <strong title={destination}>{destination}</strong></p>
        <div className="sftp-dir-mode-actions">
          <button className="sftp-dir-mode-card primary" onClick={() => resolve('preserve')}>
            <FolderInput size={20} />
            <span>保留目录结构</span>
            <small>在目标位置创建同名文件夹并递归复制内容</small>
          </button>
          <button className="sftp-dir-mode-card" onClick={() => resolve('archive')}>
            <Archive size={20} />
            <span>压缩为 .tar.gz</span>
            <small>每个文件夹生成一个压缩包，普通文件保持不变</small>
          </button>
        </div>
        <button className="sftp-conflict-btn ghost" onClick={() => resolve(null)}>取消</button>
      </div>
    </Dialog>
  )
}
