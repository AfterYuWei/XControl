import { useState, useEffect } from 'react'
import { ChevronRight } from 'lucide-react'
import { vaultApi } from '@/api/vault'
import { VAULT_TYPE_LABELS, type VaultItem } from '@/types/vault'
import { VaultSelectDialog } from './VaultSelectDialog'

interface VaultSelectButtonProps {
  vaultId?: string
  onChange: (item: VaultItem) => void
}

export function VaultSelectButton({ vaultId, onChange }: VaultSelectButtonProps) {
  const [item, setItem] = useState<VaultItem | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    if (!vaultId) {
      setItem(null)
      return
    }
    vaultApi
      .get(vaultId)
      .then(setItem)
      .catch(() => setItem(null))
  }, [vaultId])

  const handleSelect = (selected: VaultItem) => {
    setItem(selected)
    onChange(selected)
  }

  return (
    <>
      <button
        type="button"
        className="vault-select-btn"
        onClick={() => setDialogOpen(true)}
      >
        {item ? (
          <span className="vault-select-btn-summary">
            <span className={`vault-row-badge vault-row-badge-${item.type}`}>
              {VAULT_TYPE_LABELS[item.type]}
            </span>
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
