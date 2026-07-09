import { useState } from 'react'
import { AlertTriangle, Eye, KeyRound, Trash2 } from 'lucide-react'
import { vaultApi } from '@/api/vault'
import { notify } from '@/store/notify'
import { VAULT_TYPE_LABELS, type ProfileRef, type VaultItem } from '@/types/vault'
import { VAULT_TYPE_ICONS } from '@/lib/vaultIcons'

interface VaultItemRowProps {
  item: VaultItem
  onView: (item: VaultItem) => void
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

export function VaultItemRow({ item, onView, onDelete }: VaultItemRowProps) {
  const [checkingDeleteRefs, setCheckingDeleteRefs] = useState(false)
  const Icon = VAULT_TYPE_ICONS[item.type]
  const displayName = item.name || '未命名'

  const handleDelete = async () => {
    setCheckingDeleteRefs(true)
    try {
      const refs = await vaultApi.references(item.id)
      onDelete(item, refs)
    } catch {
      notify.error('查询引用失败')
    } finally {
      setCheckingDeleteRefs(false)
    }
  }

  return (
    <div className="vault-row">
      <div className="vault-row-icon">
        <Icon size={15} />
      </div>
      <div className="vault-row-main">
        <div className="vault-row-title">
          <span className="vault-row-name">{displayName}</span>
          <span className={`vault-row-badge vault-row-badge-${item.type}`}>{VAULT_TYPE_LABELS[item.type]}</span>
          {item.has_passphrase && (
            <span className="vault-row-badge vault-row-badge-passphrase" title="包含 passphrase">
              <KeyRound size={10} /> PP
            </span>
          )}
        </div>
        <div className="vault-row-meta">
          {item.username && (
            <>
              <span className="vault-row-user" title="用户名">
                {item.username}
              </span>
              <span className="vault-row-sep">·</span>
            </>
          )}
          <span className="vault-row-refs" title="被引用次数">
            引用 {item.ref_count}
          </span>
          <span className="vault-row-sep">·</span>
          <span className="vault-row-date">{formatDate(item.updated_at)}</span>
          {item.remark && (
            <>
              <span className="vault-row-sep">·</span>
              <span className="vault-row-remark" title={item.remark}>
                {item.remark}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="vault-row-actions">
        <button className="vault-act" onClick={() => onView(item)} title="查看" aria-label="查看">
          <Eye size={13} />
        </button>
        <button
          className="vault-act vault-act-danger"
          onClick={handleDelete}
          disabled={checkingDeleteRefs}
          title="删除"
          aria-label="删除"
        >
          {item.ref_count > 0 ? <AlertTriangle size={13} /> : <Trash2 size={13} />}
        </button>
      </div>
    </div>
  )
}
