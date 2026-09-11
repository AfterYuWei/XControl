export interface Session {
  id: string
  profile_id: string
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  created_at: string
}

export interface SessionCreateRequest {
  profile_id: string
  cols?: number
  rows?: number
  confirmed_host_key_fingerprint?: string
}

export interface SessionCreateResponse {
  session_id: string
  status: string
}

export interface SessionApiError {
  error?: {
    code?: string
    message?: string
  }
  host_fingerprint?: string
  known_host_fingerprint?: string
}
