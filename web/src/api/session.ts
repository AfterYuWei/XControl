import { api } from './client'
import type { Session, SessionCreateRequest, SessionCreateResponse } from '@/types/session'

export const sessionApi = {
  create: (data: SessionCreateRequest) =>
    api.post<SessionCreateResponse>('/api/sessions', data),

  list: () => api.get<Session[]>('/api/sessions'),

  confirmHostKey: (id: string, fingerprint?: string) =>
    api.post<{ status: string }>(`/api/sessions/${id}/confirm-hostkey`, { fingerprint }),

  close: (id: string) => api.delete<void>(`/api/sessions/${id}`),
}
