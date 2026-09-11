import { invoke } from '@tauri-apps/api/core'

interface CommandError {
  code?: string
  message?: string
  references?: unknown
}

class TauriAPIError extends Error {
  readonly error: { code: string; message: string }
  readonly references?: unknown

  constructor(code: string, message: string, references?: unknown) {
    super(message)
    this.name = 'TauriAPIError'
    this.error = { code, message }
    this.references = references
  }
}

export function normalizeCommandError(cause: unknown): Error & {
  error: { code: string; message: string }
  references?: unknown
} {
  if (cause instanceof TauriAPIError) return cause
  const error = cause as CommandError
  return new TauriAPIError(
    error?.code ?? 'UNKNOWN',
    error?.message ?? String(cause),
    error?.references,
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
