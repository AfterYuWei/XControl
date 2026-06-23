import { api } from './client'
import type { Session, SessionCreateRequest, SessionCreateResponse } from '@/types/session'

export const sessionApi = {
  create: (data: SessionCreateRequest) =>
    api.post<SessionCreateResponse>('/api/sessions', data),

  list: () => api.get<Session[]>('/api/sessions'),

  close: (id: string) => api.delete<void>(`/api/sessions/${id}`),
}
