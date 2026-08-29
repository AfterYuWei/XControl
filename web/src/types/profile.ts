export type ProxyType = 'direct' | 'socks5' | 'http' | 'jump'

export interface ProfileProxy {
  type: ProxyType
  host?: string
  port?: number
  username?: string
  jump_profile_id?: string
  has_password?: boolean
}

export interface ProfileProxyInput {
  type: ProxyType
  host?: string
  port?: number
  username?: string
  password?: string
  jump_profile_id?: string
}

export interface Profile {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth_type: 'password' | 'key' | 'agent' | 'vault'
  icon?: string
  vault_id?: string
  proxy: ProfileProxy
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
  auth_type: 'password' | 'key' | 'agent' | 'vault'
  icon?: string
  vault_id?: string
  password?: string
  private_key?: string
  passphrase?: string
  proxy?: ProfileProxyInput
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
  auth_type?: 'password' | 'key' | 'agent' | 'vault'
  icon?: string
  vault_id?: string
  password?: string
  private_key?: string
  passphrase?: string
  proxy?: ProfileProxyInput
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
  stages: ProfileTestStage[]
}

export interface ProfileTestStage {
  stage: 'resolve' | 'proxy' | 'host_key' | 'ssh_auth' | string
  status: 'success' | 'error'
  message: string
  profile_id?: string
  profile_name?: string
  latency_ms?: number
  known_fingerprint?: string
  fingerprint?: string
}
