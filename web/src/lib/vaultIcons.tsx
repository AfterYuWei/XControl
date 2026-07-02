import { KeyRound, KeySquare, ShieldCheck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { VaultType } from '@/types/vault'

export const VAULT_TYPE_ICONS: Record<VaultType, LucideIcon> = {
  password: KeySquare,
  private_key: KeyRound,
  ssh_certificate: ShieldCheck,
}
