// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { sftpApi } from './sftp'

afterEach(() => invokeMock.mockReset())

describe('sftpApi', () => {
  it('通过细粒度 Tauri command 发起跨会话传输', async () => {
    const response = { task_id: 'tx-1', method: 'relay', tasks: [] }
    invokeMock.mockResolvedValue(response)

    await expect(
      sftpApi.transfer('source-1', 'target-1', ['/tmp/a.txt'], '/srv', 'overwrite', 'preserve'),
    ).resolves.toEqual(response)

    expect(invokeMock).toHaveBeenCalledWith('sftp_transfer', {
      sourceSessionId: 'source-1',
      targetSessionId: 'target-1',
      paths: ['/tmp/a.txt'],
      destDir: '/srv',
      conflictResolution: 'overwrite',
      directoryMode: 'preserve',
    })
  })

  it('上传逐块发送并等待 Rust 确认，不读取完整 ArrayBuffer', async () => {
    const bytes = new Uint8Array(1024 * 1024 + 7).fill(3)
    const file = new File([bytes], '测试.bin')
    const arrayBuffer = vi.fn(() => { throw new Error('不应整文件读取') })
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer })
    Object.defineProperty(file, 'stream', {
      value: () => new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }),
    })
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'sftp_upload_begin') {
        return { upload_id: 'ul-1', tasks: [{ id: 'tx-2', status: 'transferring' }] }
      }
      if (command === 'sftp_upload_finish') {
        return { tasks: [{ id: 'tx-2', status: 'completed' }] }
      }
      return { received: bytes.length }
    })
    const onTasks = vi.fn()

    const response = await sftpApi.upload('s1', [file], '/tmp', false, onTasks)

    expect(response.tasks).toEqual([{ id: 'tx-2', status: 'completed' }])
    expect(onTasks).toHaveBeenCalledWith([{ id: 'tx-2', status: 'transferring' }])
    expect(arrayBuffer).not.toHaveBeenCalled()
    const chunks = invokeMock.mock.calls.filter(([command]) => command === 'sftp_upload_chunk')
    expect(chunks).toHaveLength(3)
    expect(chunks.every(([, chunk]) => (chunk as Uint8Array).byteLength <= 512 * 1024)).toBe(true)
    expect(chunks[0][2].headers['x-xcontrol-upload-id']).toBe('ul-1')
  })

  it('下载按 offset 拉取有界块并在 EOF 清理任务', async () => {
    const expected = new Uint8Array([1, 2, 3, 4, 5])
    invokeMock.mockImplementation(async (command: string, args: Record<string, number>) => {
      if (command === 'sftp_download_chunk') {
        return expected.slice(args.offset, args.offset + 2)
      }
      return undefined
    })

    const reader = sftpApi.streamDownloadFile('tx-3').getReader()
    const actual: number[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      actual.push(...value)
    }

    expect(actual).toEqual([...expected])
    const pulls = invokeMock.mock.calls.filter(([command]) => command === 'sftp_download_chunk')
    expect(pulls.map(([, args]) => args.offset)).toEqual([0, 2, 4, 5])
    expect(pulls.every(([, args]) => args.maxBytes === 512 * 1024)).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith('sftp_download_close', { taskId: 'tx-3' })
  })
})
