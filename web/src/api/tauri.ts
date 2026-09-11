import { invoke } from '@tauri-apps/api/core'

interface CommandError {
  code?: string
  message?: string
  retryable?: boolean
  details?: unknown
  session_id?: string
  stage?: string
  references?: unknown
}

class TauriAPIError extends Error {
  readonly error: { code: string; message: string }
  readonly references?: unknown
  readonly retryable: boolean
  readonly details?: unknown
  readonly sessionId?: string
  readonly stage?: string

  constructor(code: string, message: string, context: Omit<CommandError, 'code' | 'message'> = {}) {
    super(message)
    this.name = 'TauriAPIError'
    this.error = { code, message }
    this.references = context.references
    this.retryable = context.retryable ?? false
    this.details = context.details
    this.sessionId = context.session_id
    this.stage = context.stage
  }
}

export function normalizeCommandError(cause: unknown): Error & {
  error: { code: string; message: string }
  references?: unknown
  retryable: boolean
  details?: unknown
  sessionId?: string
  stage?: string
} {
  if (cause instanceof TauriAPIError) return cause
  const error = cause as CommandError
  return new TauriAPIError(
    error?.code ?? 'UNKNOWN',
    error?.message ?? String(cause),
    error,
  )
}

export async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (cause) {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
      throw new TauriAPIError(
        'TAURI_UNAVAILABLE',
        '此功能需要 eizhu 客户端，请使用 make dev 启动完整开发环境',
      )
    }
    throw normalizeCommandError(cause)
  }
}
