import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { vaultApi } from '@/api/vault'
import { notify } from '@/store/notify'
import { VAULT_TYPE_LABELS, type VaultItem } from '@/types/vault'
import { VAULT_TYPE_ICONS } from '@/lib/vaultIcons'

interface VaultSelectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedId?: string
  onSelect: (item: VaultItem) => void
}

function formatDate(iso: string): string {
  try {
    const value = new Date(iso)
    return value.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
  } catch {
    return ''
  }
}

export function VaultSelectDialog({ open, onOpenChange, selectedId, onSelect }: VaultSelectDialogProps) {
  const [items, setItems] = useState<VaultItem[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!open) return
    setLoading(true)
    vaultApi
      .list()
      .then((list) => setItems(list ?? []))
      .catch(() => notify.error('加载凭据列表失败'))
      .finally(() => setLoading(false))
  }, [open])

  const filtered = search
    ? items.filter(
        (item) =>
          item.name.toLowerCase().includes(search.toLowerCase()) ||
          item.remark.toLowerCase().includes(search.toLowerCase()),
      )
    : items

  const handleSelect = (item: VaultItem) => {
    onSelect(item)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)} className="vault-select-dialog-content">
        <DialogHeader className="mb-4">
          <DialogTitle>从 Vault 选择凭据</DialogTitle>
        </DialogHeader>

        <input
          type="text"
          className="vault-select-search"
          placeholder="搜索名称 / 备注"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          autoFocus
        />

        <div className="vault-select-list">
          {loading ? (
            <div className="vault-select-empty">加载中...</div>
          ) : filtered.length === 0 ? (
            <div className="vault-select-empty">无匹配凭据</div>
          ) : (
            filtered.map((item) => {
              const Icon = VAULT_TYPE_ICONS[item.type]
              const isSelected = item.id === selectedId
              return (
                <div
                  key={item.id}
                  className={`vault-select-row ${isSelected ? 'selected' : ''}`}
                  onClick={() => handleSelect(item)}
                  role="option"
                  aria-selected={isSelected}
                >
                  <div className="vault-row-icon">
                    <Icon size={15} />
                  </div>
                  <div className="vault-row-main">
                    <div className="vault-row-title">
                      <span className="vault-row-name">{item.name || '未命名'}</span>
                      <span className={`vault-row-badge vault-row-badge-${item.type}`}>{VAULT_TYPE_LABELS[item.type]}</span>
                    </div>
                    <div className="vault-row-meta">
                      <span className="vault-row-user">{item.username || '-'}</span>
                      <span className="vault-row-sep">·</span>
                      <span>引用 {item.ref_count}</span>
                      <span className="vault-row-sep">·</span>
                      <span className="vault-row-date">{formatDate(item.updated_at)}</span>
                    </div>
                  </div>
                  {isSelected && <Check size={14} style={{ color: 'var(--accent)' }} />}
                </div>
              )
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
