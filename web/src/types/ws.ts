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
  | 'cwd'
  | 'complete_request'
  | 'complete_response'

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

export interface CwdPayload {
  path: string
}

// 动态补全:客户端请求远端执行只读脚本
export interface CompleteRequestPayload {
  request_id: string
  script: string
  cwd?: string
}

// 动态补全:服务端返回脚本执行结果
export interface CompleteResponsePayload {
  request_id: string
  output: string
  error: string
  exit_code: number
}
