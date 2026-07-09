import { LockKeyhole, KeyRound } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { VaultType } from '@/types/vault'

export const VAULT_TYPE_ICONS: Record<VaultType, LucideIcon> = {
  password: LockKeyhole,
  private_key: KeyRound,
}
