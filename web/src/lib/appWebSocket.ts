import { isTauri } from './desktop'
import { recordFrontendLog } from './appLog'
import type TauriWebSocket from '@tauri-apps/plugin-websocket'
import type { Message as TauriMessage } from '@tauri-apps/plugin-websocket'

export const SOCKET_CONNECTING = 0
export const SOCKET_OPEN = 1
export const SOCKET_CLOSING = 2
export const SOCKET_CLOSED = 3

/** 浏览器 WebSocket 与 Tauri Rust WebSocket 共用的最小接口。 */
export interface AppWebSocket {
  readonly readyState: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  send(data: string): void
  close(): void
}

class RustWebSocketAdapter implements AppWebSocket {
  readyState = SOCKET_CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  private socket: TauriWebSocket | null = null
  private removeListener: (() => void) | null = null
  private disposed = false

  private readonly url: string

  constructor(url: string) {
    this.url = url
    void this.connect()
  }

  private async connect(): Promise<void> {
    try {
      const { default: TauriSocket } = await import('@tauri-apps/plugin-websocket')
      const socket = await TauriSocket.connect(this.url)
      if (this.disposed) {
        await socket.disconnect()
        return
      }

      this.socket = socket
      // 先安装消息监听器再通知业务层已连接，确保 onopen 中立即 send 安全，
      // 也尽量缩短插件 connect 完成后的首条消息监听空窗。
      this.removeListener = socket.addListener((message) => this.handleMessage(message))
      this.readyState = SOCKET_OPEN
      this.onopen?.(new Event('open'))
    } catch (error) {
      if (this.disposed) return
      this.readyState = SOCKET_CLOSED
      recordFrontendLog('ERROR', 'native websocket connect failed', {
        path: new URL(this.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      })
      this.onerror?.(new Event('error'))
      this.onclose?.(new CloseEvent('close'))
    }
  }

  private handleMessage(message: TauriMessage): void {
    switch (message.type) {
      case 'Text':
        this.onmessage?.(new MessageEvent('message', { data: message.data }))
        break
      case 'Binary':
        this.onmessage?.(new MessageEvent('message', { data: new Uint8Array(message.data) }))
        break
      case 'Close':
        this.finishClose()
        break
      case 'Ping':
      case 'Pong':
        // 应用层心跳使用 JSON text；协议层控制帧由插件自行处理。
        break
    }
  }

  send(data: string): void {
    if (this.readyState !== SOCKET_OPEN || !this.socket) return
    void this.socket.send(data).catch((error) => {
      recordFrontendLog('ERROR', 'native websocket send failed', {
        path: new URL(this.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      })
      this.onerror?.(new Event('error'))
    })
  }

  close(): void {
    if (this.readyState === SOCKET_CLOSING || this.readyState === SOCKET_CLOSED) return
    this.disposed = true
    this.readyState = SOCKET_CLOSING
    const socket = this.socket
    this.removeListener?.()
    this.removeListener = null
    this.socket = null
    if (socket) {
      void socket.disconnect().finally(() => this.finishClose())
    } else {
      this.finishClose()
    }
  }

  private finishClose(): void {
    if (this.readyState === SOCKET_CLOSED) return
    this.disposed = true
    this.removeListener?.()
    this.removeListener = null
    this.socket = null
    this.readyState = SOCKET_CLOSED
    this.onclose?.(new CloseEvent('close'))
  }
}

/**
 * 浏览器使用原生 WebSocket；Tauri 使用 Rust 原生插件，避免 WebView 直接访问
 * 127.0.0.1。返回同步适配器，调用方可沿用 onopen/onmessage/send/close 语义。
 */
export function createAppWebSocket(url: string): AppWebSocket {
  if (isTauri()) return new RustWebSocketAdapter(url)
  return new WebSocket(url)
}
