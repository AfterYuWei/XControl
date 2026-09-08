import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeCommand } = vi.hoisted(() => ({ invokeCommand: vi.fn() }))

vi.mock('./tauri', () => ({ invokeCommand }))

import { sessionApi } from './session'

describe('sessionApi', () => {
  beforeEach(() => invokeCommand.mockReset())

  it('creates and closes sessions through fine-grained Rust commands', async () => {
    invokeCommand.mockResolvedValue(undefined)
    const request = { profile_id: 'p1', cols: 120, rows: 40 }
    await sessionApi.create(request)
    await sessionApi.close('s1')
    expect(invokeCommand).toHaveBeenNthCalledWith(1, 'session_create', { request })
    expect(invokeCommand).toHaveBeenNthCalledWith(2, 'session_close', { id: 's1' })
  })

  it('routes terminal I/O and completion through Rust commands', async () => {
    invokeCommand.mockResolvedValue(undefined)
    await sessionApi.input('s1', 'ls\r')
    await sessionApi.resize('s1', 100, 30)
    await sessionApi.complete('s1', 'r1', 'git branch', '/tmp')
    expect(invokeCommand).toHaveBeenNthCalledWith(1, 'session_input', {
      id: 's1',
      data: 'ls\r',
    })
    expect(invokeCommand).toHaveBeenNthCalledWith(2, 'session_resize', {
      id: 's1',
      cols: 100,
      rows: 30,
    })
    expect(invokeCommand).toHaveBeenNthCalledWith(3, 'session_complete', {
      id: 's1',
      requestId: 'r1',
      script: 'git branch',
      cwd: '/tmp',
    })
  })
})
