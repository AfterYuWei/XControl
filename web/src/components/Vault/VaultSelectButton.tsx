import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { vaultApi } from '@/api/vault'
import { VAULT_TYPE_LABELS, type VaultItem } from '@/types/vault'
import { VAULT_TYPE_ICONS } from '@/lib/vaultIcons'
import { VaultSelectDialog } from './VaultSelectDialog'

interface VaultSelectButtonProps {
  vaultId?: string
  onChange: (item: VaultItem) => void
  onItemResolved?: (item: VaultItem | null) => void
}

export function VaultSelectButton({ vaultId, onChange, onItemResolved }: VaultSelectButtonProps) {
  const [item, setItem] = useState<VaultItem | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    if (!vaultId) {
      setItem(null)
      onItemResolved?.(null)
      return
    }
    vaultApi
      .get(vaultId)
      .then((resolved) => {
        setItem(resolved)
        onItemResolved?.(resolved)
      })
      .catch(() => {
        setItem(null)
        onItemResolved?.(null)
      })
  }, [onItemResolved, vaultId])

  const handleSelect = (selected: VaultItem) => {
    setItem(selected)
    onItemResolved?.(selected)
    onChange(selected)
  }

  const Icon = item ? VAULT_TYPE_ICONS[item.type] : null

  return (
    <>
      <button type="button" className="vault-select-btn" onClick={() => setDialogOpen(true)}>
        {item ? (
          <span className="vault-select-btn-summary">
            {Icon && <Icon size={14} />}
            <span className={`vault-row-badge vault-row-badge-${item.type}`}>{VAULT_TYPE_LABELS[item.type]}</span>
            {item.username && <span style={{ color: 'var(--fg-4)', fontSize: '11px' }}>{item.username}@</span>}
            <span>{item.name || '未命名'}</span>
          </span>
        ) : (
          <span className="vault-select-btn-placeholder">点击选择 Vault 凭据</span>
        )}
        <ChevronRight size={14} style={{ color: 'var(--fg-4)' }} />
      </button>

      <VaultSelectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        selectedId={vaultId}
        onSelect={handleSelect}
      />
    </>
  )
}
