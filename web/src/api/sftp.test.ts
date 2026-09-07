// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/desktop', () => ({
  isTauri: () => false,
  apiBase: () => 'http://127.0.0.1:19090',
  authHeaders: () => ({ Authorization: 'Bearer desktop-token' }),
}))

import { sftpApi } from './sftp'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sftpApi.transfer', () => {
  it('通过桌面鉴权 fetch 调用动态端口 sidecar', async () => {
    const response = { task_id: 'tx-1', method: 'auto', tasks: [] }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      sftpApi.transfer('source-1', 'target-1', ['/tmp/a.txt'], '/srv', 'overwrite', 'preserve'),
    ).resolves.toEqual(response)

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:19090/api/sftp/transfer', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer desktop-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source_session_id: 'source-1',
        target_session_id: 'target-1',
        paths: ['/tmp/a.txt'],
        dest_dir: '/srv',
        conflict_resolution: 'overwrite',
        directory_mode: 'preserve',
      }),
    })
  })
})
