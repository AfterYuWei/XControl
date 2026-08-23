import type { VaultItem, VaultType } from '@/types/vault'

export function normalizeVaultUsername(type: VaultType, username?: string): string {
  return type === 'password' ? username?.trim() ?? '' : ''
}

export function vaultNeedsUsername(item: Pick<VaultItem, 'type' | 'username'>): boolean {
  return item.type === 'password' && normalizeVaultUsername(item.type, item.username) === ''
}

export function applyVaultUsernameToProfile(
  item: Pick<VaultItem, 'type' | 'username'>,
  currentUsername: string,
  previousAutoUsername: string,
): { username: string; autoUsername: string } {
  const autoUsername = normalizeVaultUsername(item.type, item.username)
  if (item.type === 'password') return { username: autoUsername, autoUsername }
  return {
    username: previousAutoUsername && currentUsername === previousAutoUsername ? '' : currentUsername,
    autoUsername: '',
  }
}
