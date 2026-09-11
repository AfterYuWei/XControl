import { invokeCommand } from './tauri'
import type { Session, SessionCreateRequest, SessionCreateResponse } from '@/types/session'
import type { SessionMessage } from '@/types/sessionMessage'

export const sessionApi = {
  create: (data: SessionCreateRequest) =>
    invokeCommand<SessionCreateResponse>('session_create', { request: data }),

  list: () => invokeCommand<Session[]>('session_list'),

  attach: (id: string) => invokeCommand<SessionMessage[]>('session_attach', { id }),

  confirmHostKey: (id: string, fingerprint?: string) =>
    invokeCommand<{ status: string }>('session_confirm_host_key', { id, fingerprint }),

  input: (id: string, data: string) => invokeCommand<void>('session_input', { id, data }),

  resize: (id: string, cols: number, rows: number) =>
    invokeCommand<void>('session_resize', { id, cols, rows }),

  ping: (id: string) => invokeCommand<void>('session_ping', { id }),

  complete: (id: string, requestId: string, script: string, cwd?: string) =>
    invokeCommand<void>('session_complete', { id, requestId, script, cwd }),

  close: (id: string) => invokeCommand<void>('session_close', { id }),
}
