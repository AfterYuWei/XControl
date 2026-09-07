import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/lib/desktop'
import { importBackup, previewBackup, type BackupSource } from './backup'

vi.mock('@/lib/desktop', () => ({
  isTauri: vi.fn(),
  apiBase: () => '',
  authHeaders: () => ({}),
  saveApiFileToDisk: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

function browserSource(content: string): BackupSource {
  return { name: 'demo.xcbackup', file: new File([content], 'demo.xcbackup') }
}

function pathSource(): BackupSource {
  return { name: 'demo.xcbackup', path: '/home/user/Downloads/demo.xcbackup' }
}

const importResult = {
  imported: { groups: 1, vault: 0, profiles: 2, snippets: 0 },
  skipped: { groups: 0, vault: 0, profiles: 0, snippets: 0 },
}

describe('backup upload（浏览器分支）', () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(false)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** WebView2/WebKit 下 input File 为 file-backed blob，无法直接经 fetch FormData
   *  发送（"Failed to fetch"）；浏览器分支必须先读入内存再以内存 Blob 追加。 */
  it('以内存 Blob 携带文件内容与原始文件名上传', async () => {
    const content = JSON.stringify({ format: 'xcontrol-backup', version: 1 })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(importResult), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await importBackup(browserSource(content), 'skip')

    expect(result).toEqual(importResult)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const form = init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    const part = form.get('file')
    expect(part).toBeInstanceOf(Blob)
    expect((part as File).name).toBe('demo.xcbackup')
    expect(await (part as Blob).text()).toBe(content)
    expect(form.get('strategy')).toBe('skip')
  })

  it('preview 未提供密码时不附加空 password 字段', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await previewBackup(browserSource('{}'))

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.body as FormData).has('password')).toBe(false)
  })
})

describe('backup upload（桌面分支）', () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('走 Rust upload_file_form 上传并解析结果', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(invoke).mockResolvedValue({ status: 200, body: JSON.stringify(importResult) })

    const result = await importBackup(pathSource(), 'overwrite', 'secret')

    expect(result).toEqual(importResult)
    expect(invoke).toHaveBeenCalledWith('upload_file_form', {
      endpoint: '/api/backup/import',
      filePath: '/home/user/Downloads/demo.xcbackup',
      fields: { strategy: 'overwrite', password: 'secret' },
    })
    // 桌面分支绝不触碰 webview 网络栈
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('空字段不传给 Rust 命令', async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 200, body: '{}' })

    await previewBackup(pathSource())

    expect(invoke).toHaveBeenCalledWith('upload_file_form', {
      endpoint: '/api/backup/preview',
      filePath: '/home/user/Downloads/demo.xcbackup',
      fields: {},
    })
  })

  it('非 2xx 结果抛出与 fetch 分支同构的 APIError', async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 400,
      body: JSON.stringify({ error: { code: 'PASSWORD_REQUIRED', message: '需要密码' } }),
    })

    await expect(previewBackup(pathSource())).rejects.toMatchObject({
      error: { code: 'PASSWORD_REQUIRED', message: '需要密码' },
    })
  })

  it('响应体非 JSON 时抛出 UNKNOWN 错误', async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 500, body: 'server exploded' })

    await expect(previewBackup(pathSource())).rejects.toMatchObject({
      error: { code: 'UNKNOWN', message: 'server exploded' },
    })
  })
})
