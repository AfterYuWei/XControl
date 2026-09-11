import { describe, expect, it } from 'vitest'
import { normalizeCommandError } from './tauri'

describe('Tauri 结构化错误', () => {
  it('保留重试、会话、阶段与详情上下文', () => {
    const error = normalizeCommandError({
      code: 'BACKGROUND_LIMIT',
      message: 'window expired',
      retryable: true,
      session_id: 'session-1',
      stage: 'background',
      details: { remaining_seconds: 0 },
    })
    expect(error.error.code).toBe('BACKGROUND_LIMIT')
    expect(error.retryable).toBe(true)
    expect(error.sessionId).toBe('session-1')
    expect(error.stage).toBe('background')
    expect(error.details).toEqual({ remaining_seconds: 0 })
  })
})
