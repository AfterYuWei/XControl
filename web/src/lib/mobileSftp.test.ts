import { describe, expect, it } from 'vitest'
import {
  isEditableMobileSftpEntry,
  isWithinMobileLongPressSlop,
  mobileSftpLayout,
  mobileDestinationError,
  MOBILE_SFTP_LONG_PRESS_MS,
  summarizeMobileTransfers,
} from './mobileSftp'
import type { SftpEntry, TransferTask } from '@/types/sftp'

const entry = (path: string, isDir = false, size = 12): SftpEntry => ({
  path,
  name: path.split('/').at(-1) || '/',
  is_dir: isDir,
  size,
  mod_time: '2026-09-12T08:00:00Z',
})

describe('移动 SFTP 交互规则', () => {
  it('在 768px 媒体查询跨越时切换手机和平板布局', () => {
    expect(mobileSftpLayout(false)).toBe('phone')
    expect(mobileSftpLayout(true)).toBe('tablet')
  })

  it('只把 10 MiB 内的文本候选交给编辑器', () => {
    expect(isEditableMobileSftpEntry(entry('/readme.md'))).toBe(true)
    expect(isEditableMobileSftpEntry(entry('/LICENSE'))).toBe(true)
    expect(isEditableMobileSftpEntry(entry('/photo.png'))).toBe(false)
    expect(isEditableMobileSftpEntry(entry('/huge.txt', false, 10 * 1024 * 1024 + 1))).toBe(false)
    expect(isEditableMobileSftpEntry(entry('/folder', true))).toBe(false)
  })

  it('使用 450ms 长按且允许不超过 10px 的触控迟滞', () => {
    expect(MOBILE_SFTP_LONG_PRESS_MS).toBe(450)
    expect(isWithinMobileLongPressSlop(0, 0, 6, 8)).toBe(true)
    expect(isWithinMobileLongPressSlop(0, 0, 7, 8)).toBe(false)
  })

  it('阻止同会话移动到原目录、自身或子目录', () => {
    const folder = entry('/srv/project', true)
    expect(mobileDestinationError('move', 'same', 'same', [folder], '/srv')).toBe('项目已位于该目录')
    expect(mobileDestinationError('move', 'same', 'same', [folder], '/srv/project/build')).toBe('不能选择文件夹自身或其子目录')
    expect(mobileDestinationError('copy', 'same', 'other', [folder], '/srv/project/build')).toBeNull()
  })

  it('汇总活动、失败任务和平均进度', () => {
    const task = (id: string, status: TransferTask['status'], transferred: number): TransferTask => ({
      id,
      file_name: `${id}.txt`,
      direction: 'download',
      size: 100,
      transferred,
      status,
      speed: 10,
      started_at: 1,
    })
    const summary = summarizeMobileTransfers([
      task('one', 'transferring', 25),
      task('two', 'queued', 0),
      task('three', 'failed', 40),
    ])
    expect(summary.active.map((item) => item.id)).toEqual(['one', 'two'])
    expect(summary.failed.map((item) => item.id)).toEqual(['three'])
    expect(summary.progress).toBe(0.125)
  })
})
