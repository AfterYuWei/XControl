// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isTauri } from './desktop'
import { createAppWebSocket, SOCKET_CLOSED, SOCKET_OPEN } from './appWebSocket'

const plugin = vi.hoisted(() => {
  let listener: ((message: { type: string; data?: unknown }) => void) | null = null
  const socket = {
    addListener: vi.fn((callback) => {
      listener = callback
      return vi.fn()
    }),
    send: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }
  return {
    socket,
    connect: vi.fn().mockResolvedValue(socket),
    emit(message: { type: string; data?: unknown }) {
      listener?.(message)
    },
  }
})

vi.mock('./desktop', () => ({ isTauri: vi.fn() }))
vi.mock('./appLog', () => ({ recordFrontendLog: vi.fn() }))
vi.mock('@tauri-apps/plugin-websocket', () => ({
  default: { connect: plugin.connect },
}))

beforeEach(() => {
  vi.mocked(isTauri).mockReset()
  plugin.connect.mockClear()
  plugin.socket.addListener.mockClear()
  plugin.socket.send.mockClear()
  plugin.socket.disconnect.mockClear()
})

describe('createAppWebSocket', () => {
  it('Tauri 使用 Rust 插件，并转发文本消息和发送操作', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    const socket = createAppWebSocket('ws://127.0.0.1:9090/ws?access_token=secret')
    const onOpen = vi.fn()
    const onMessage = vi.fn()
    socket.onopen = onOpen
    socket.onmessage = onMessage

    await vi.waitFor(() => expect(socket.readyState).toBe(SOCKET_OPEN))
    expect(plugin.connect).toHaveBeenCalledWith('ws://127.0.0.1:9090/ws?access_token=secret')
    expect(onOpen).toHaveBeenCalledOnce()

    plugin.emit({ type: 'Text', data: '{"type":"pong"}' })
    expect(onMessage.mock.calls[0][0].data).toBe('{"type":"pong"}')

    socket.send('{"type":"ping"}')
    await vi.waitFor(() => expect(plugin.socket.send).toHaveBeenCalledWith('{"type":"ping"}'))
  })

  it('关闭适配器时释放 Rust 连接', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    const socket = createAppWebSocket('ws://127.0.0.1:9090/ws')
    await vi.waitFor(() => expect(socket.readyState).toBe(SOCKET_OPEN))

    socket.close()

    await vi.waitFor(() => expect(socket.readyState).toBe(SOCKET_CLOSED))
    expect(plugin.socket.disconnect).toHaveBeenCalledOnce()
  })
})
