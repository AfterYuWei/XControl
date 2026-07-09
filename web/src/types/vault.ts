export type VaultType = 'password' | 'private_key'

export interface VaultItem {
  id: string
  name: string
  type: VaultType
  username: string
  remark: string
  fingerprint: string
  ref_count: number
  has_passphrase: boolean
  created_at: string
  updated_at: string
}

export interface VaultCredential {
  password?: string
  private_key?: string
  passphrase?: string
  public_key?: string
}

export interface VaultCreateRequest {
  name: string
  type: VaultType
  username?: string
  remark?: string
  password?: string
  private_key?: string
  public_key?: string
  passphrase?: string
}

export type VaultUpdateRequest = VaultCreateRequest

export interface GenerateKeyRequest {
  algo: 'rsa' | 'ed25519'
  bits?: number
  passphrase?: string
}

export interface GenerateKeyResponse {
  public_key: string
  private_key: string
  fingerprint: string
}

export interface ProfileRef {
  id: string
  name: string
}

export const VAULT_TYPE_LABELS: Record<VaultType, string> = {
  password: '密码',
  private_key: '私钥',
}

export const VAULT_TYPE_ALL = 'all' as const
export type VaultFilterType = VaultType | typeof VAULT_TYPE_ALL
