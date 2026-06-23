export type WSMessageType =
  | 'input'
  | 'output'
  | 'resize'
  | 'exit'
  | 'error'
  | 'ping'
  | 'pong'
  | 'auth'
  | 'metadata'

export interface WSMessage {
  type: WSMessageType
  data?: string
  payload?: unknown
}

export interface ResizePayload {
  cols: number
  rows: number
}

export interface ExitPayload {
  code: number
}

export interface ErrorPayload {
  code: string
  message: string
}

export interface MetaPayload {
  session_id: string
  host: string
  username: string
  protocol: string
}
