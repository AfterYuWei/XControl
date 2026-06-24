export interface Profile {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth_type: 'password' | 'key' | 'agent'
  icon?: string
  vault_id?: string
  group_id?: string
  tags: string[]
  options: string // JSON string
  note: string
  sort_order: number
  last_used_at?: string
  created_at: string
  updated_at: string
}

export interface ProfileCreateRequest {
  name: string
  host: string
  port?: number
  username: string
  auth_type: 'password' | 'key' | 'agent'
  icon?: string
  password?: string
  private_key?: string
  passphrase?: string
  group_id?: string
  tags?: string[]
  options?: string
  note?: string
}

export interface ProfileUpdateRequest {
  name?: string
  host?: string
  port?: number
  username?: string
  auth_type?: 'password' | 'key' | 'agent'
  icon?: string
  password?: string
  private_key?: string
  passphrase?: string
  group_id?: string
  tags?: string[]
  options?: string
  note?: string
}

export interface ProfileTestResult {
  success: boolean
  message: string
  latency_ms: number
  server_info?: string
}
