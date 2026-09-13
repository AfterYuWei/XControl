import { parentPath, pathWithin } from '@/store/sftp'
import type { SftpEntry, TransferTask } from '@/types/sftp'

export const MOBILE_SFTP_LONG_PRESS_MS = 450
export const MOBILE_SFTP_LONG_PRESS_SLOP = 10
export const MOBILE_SFTP_MAX_EDITABLE_BYTES = 10 * 1024 * 1024
export const MOBILE_SFTP_TABLET_QUERY = '(min-width: 768px)'

export function mobileSftpLayout(tabletQueryMatches: boolean): 'phone' | 'tablet' {
  return tabletQueryMatches ? 'tablet' : 'phone'
}

export function summarizeMobileTransfers(transfers: TransferTask[]) {
  const active = transfers.filter((task) => task.status === 'queued' || task.status === 'transferring')
  const failed = transfers.filter((task) => task.status === 'failed')
  const progress = active.length
    ? active.reduce((sum, task) => sum + (task.size ? task.transferred / task.size : 0), 0) / active.length
    : 1
  return { active, failed, progress }
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'log', 'conf', 'cfg', 'ini', 'env', 'json', 'jsonc', 'xml', 'yaml', 'yml',
  'toml', 'csv', 'tsv', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less', 'html', 'htm',
  'sh', 'bash', 'zsh', 'fish', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h',
  'cpp', 'hpp', 'sql', 'php', 'vue', 'svelte', 'dockerfile', 'gitignore', 'properties',
])

export type MobileDirectoryAction = 'navigate' | 'copy' | 'move'

export function isEditableMobileSftpEntry(entry: SftpEntry): boolean {
  if (entry.is_dir || entry.size > MOBILE_SFTP_MAX_EDITABLE_BYTES) return false
  const name = entry.name.toLowerCase()
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  return !extension || TEXT_EXTENSIONS.has(extension)
}

export function isWithinMobileLongPressSlop(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
): boolean {
  return Math.hypot(currentX - startX, currentY - startY) <= MOBILE_SFTP_LONG_PRESS_SLOP
}

export function mobileDestinationError(
  action: MobileDirectoryAction,
  sourceSessionId: string,
  targetSessionId: string,
  entries: SftpEntry[],
  destDir: string,
): string | null {
  if (action === 'navigate') return null
  if (sourceSessionId !== targetSessionId) return null
  for (const entry of entries) {
    if (entry.is_dir && pathWithin(destDir, entry.path)) return '不能选择文件夹自身或其子目录'
    if (action === 'move' && parentPath(entry.path) === destDir) return '项目已位于该目录'
  }
  return null
}
