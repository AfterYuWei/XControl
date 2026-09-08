import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  exportBackup,
  importBackup,
  pickBackupFile,
  previewBackup,
  type BackupSource,
} from './backup'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const source: BackupSource = {
  name: 'demo.xcbackup',
  path: '/home/user/Downloads/demo.xcbackup',
}

describe('backup Rust commands', () => {
  beforeEach(() => vi.mocked(invoke).mockReset())

  it('导出直接调用 Rust 并且不传递文件正文', async () => {
    vi.mocked(invoke).mockResolvedValue('/home/user/backup.xcbackup')

    await exportBackup('encrypted', 'secret')

    expect(invoke).toHaveBeenCalledWith('backup_export', {
      mode: 'encrypted',
      password: 'secret',
    })
  })

  it('选择文件后只保留 Rust 返回的路径和显示名', async () => {
    vi.mocked(invoke).mockResolvedValue('C:\\Users\\demo.xcbackup')

    await expect(pickBackupFile()).resolves.toEqual({
      name: 'demo.xcbackup',
      path: 'C:\\Users\\demo.xcbackup',
    })
    expect(invoke).toHaveBeenCalledWith('backup_pick_file', undefined)
  })

  it('预览与导入通过细粒度命令传递文件路径', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ stats: {}, conflicts: {} })
      .mockResolvedValueOnce({ imported: {}, skipped: {} })

    await previewBackup(source)
    await importBackup(source, 'overwrite', 'secret')

    expect(invoke).toHaveBeenNthCalledWith(1, 'backup_preview', {
      filePath: source.path,
      password: undefined,
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'backup_import', {
      filePath: source.path,
      strategy: 'overwrite',
      password: 'secret',
    })
  })
})
