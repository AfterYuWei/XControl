export interface Session {
  id: string
  profile_id: string
  status: 'connecting' | 'connected' | 'disconnected'
  created_at: string
}

export interface SessionCreateRequest {
  profile_id: string
  cols?: number
  rows?: number
}

export interface SessionCreateResponse {
  session_id: string
  status: string
}
