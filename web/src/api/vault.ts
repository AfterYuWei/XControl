import { invokeCommand } from './tauri'
import type {
  VaultItem,
  VaultCredential,
  VaultCreateRequest,
  VaultUpdateRequest,
  GenerateKeyRequest,
  GenerateKeyResponse,
  ProfileRef,
  VaultType,
} from '@/types/vault'

export interface VaultListParams {
  type?: VaultType
  q?: string
}

export const vaultApi = {
  list: (params?: VaultListParams) =>
    invokeCommand<VaultItem[]>('vault_list', {
      vaultType: params?.type ?? null,
      q: params?.q ?? null,
    }),

  get: (id: string) => invokeCommand<VaultItem>('vault_get', { id }),

  create: (data: VaultCreateRequest) =>
    invokeCommand<VaultItem>('vault_create', { request: data }),

  update: (id: string, data: VaultUpdateRequest) =>
    invokeCommand<VaultItem>('vault_update', { id, request: data }),

  delete: (id: string) => invokeCommand<void>('vault_delete', { id }),

  references: (id: string) =>
    invokeCommand<ProfileRef[]>('vault_references', { id }),

  reveal: (id: string) =>
    invokeCommand<VaultCredential>('vault_reveal', { id }),

  generateKeyPair: (data: GenerateKeyRequest) =>
    invokeCommand<GenerateKeyResponse>('vault_generate_key_pair', {
      request: data,
    }),
}

export interface APIError extends Error {
  error: { code: string; message: string }
  references?: unknown
}
