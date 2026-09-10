import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useSftpStore } from './storeContext'

export function HostKeyDialog() {
  const pending = useSftpStore((state) => state.pendingHostKey)
  const decide = useSftpStore((state) => state.decideHostKey)

  return (
    <AlertDialog open={pending !== null}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldAlert size={18} /> 确认 SFTP 主机指纹
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pending?.knownFingerprint
              ? `${pending.serverName} 返回的主机指纹与已保存记录不一致。`
              : `这是首次通过 SFTP 连接 ${pending?.serverName ?? '服务器'}。`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-3 text-xs">
          {pending?.knownFingerprint && (
            <p className="break-all"><span className="text-[var(--fg-4)]">历史：</span>{pending.knownFingerprint}</p>
          )}
          <p className="break-all"><span className="text-[var(--fg-4)]">当前：</span>{pending?.fingerprint}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => void decide('reject')}>拒绝</Button>
          <Button variant="outline" onClick={() => void decide('trust_once')}>仅本次信任</Button>
          <Button onClick={() => void decide('trust_permanently')}>永久信任并继续</Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
