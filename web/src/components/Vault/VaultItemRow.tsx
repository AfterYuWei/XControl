import { useState } from 'react'
import { AlertTriangle, Pencil, KeyRound, Trash2 } from 'lucide-react'
import { vaultApi } from '@/api/vault'
import { toast } from 'sonner'
import { VAULT_TYPE_LABELS, type ProfileRef, type VaultItem } from '@/types/vault'
import { VAULT_TYPE_ICONS } from '@/lib/vaultIcons'

interface VaultItemRowProps {
  item: VaultItem
  onEdit: (item: VaultItem) => void
  onDelete: (item: VaultItem, refs: ProfileRef[]) => void
}

function formatDate(iso: string): string {
  try {
    const value = new Date(iso)
    return value.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
  } catch {
    return ''
  }
}

export function VaultItemRow({ item, onEdit, onDelete }: VaultItemRowProps) {
  const [checkingDeleteRefs, setCheckingDeleteRefs] = useState(false)
  const Icon = VAULT_TYPE_ICONS[item.type]
  const displayName = item.name || '未命名'

  const handleDelete = async () => {
    setCheckingDeleteRefs(true)
    try {
      const refs = await vaultApi.references(item.id)
      onDelete(item, refs)
    } catch {
      toast.error('查询引用失败')
    } finally {
      setCheckingDeleteRefs(false)
    }
  }

  return (
    <div className="vault-card">
      <div className="vault-card-header">
        <div className="vault-card-icon">
          <Icon size={16} />
        </div>
        <div className="vault-card-title-row">
          <span className="vault-card-name">{displayName}</span>
          <span className={`vault-card-badge vault-card-badge-${item.type}`}>
            {VAULT_TYPE_LABELS[item.type]}
          </span>
        </div>
      </div>

      <div className="vault-card-body">
        <div className="vault-card-field">
          <span className="vault-card-label">用户名</span>
          <span className="vault-card-value">{item.username || '-'}</span>
        </div>
        {item.remark && (
          <div className="vault-card-field">
            <span className="vault-card-label">备注</span>
            <span className="vault-card-value vault-card-remark">{item.remark}</span>
          </div>
        )}
        <div className="vault-card-field">
          <span className="vault-card-label">引用</span>
          <span className="vault-card-value">{item.ref_count}</span>
        </div>
        <div className="vault-card-field">
          <span className="vault-card-label">更新</span>
          <span className="vault-card-value">{formatDate(item.updated_at)}</span>
        </div>
      </div>

      {item.has_passphrase && (
        <div className="vault-card-footer">
          <span className="vault-card-passphrase">
            <KeyRound size={10} /> 包含 passphrase
          </span>
        </div>
      )}

      <div className="vault-card-actions">
        <button className="vault-card-act" onClick={() => onEdit(item)} title="编辑">
          <Pencil size={14} />
        </button>
        <button
          className="vault-card-act vault-card-act-danger"
          onClick={handleDelete}
          disabled={checkingDeleteRefs}
          title="删除"
        >
          {item.ref_count > 0 ? <AlertTriangle size={14} /> : <Trash2 size={14} />}
        </button>
      </div>
    </div>
  )
}
