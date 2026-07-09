import { KeyRound, AlertCircle, Plus } from 'lucide-react'
import { useVaultStore } from '@/store/vault'
import { VaultItemRow } from './VaultItemRow'
import { Button } from '@/components/ui/button'
import type { VaultItem, ProfileRef } from '@/types/vault'

interface VaultListProps {
  onEdit: (item: VaultItem) => void
  onDelete: (item: VaultItem, refs: ProfileRef[]) => void
  onCreate: () => void
}

export function VaultList({ onEdit, onDelete, onCreate }: VaultListProps) {
  const { items, loading, error, fetchList } = useVaultStore()

  // 加载态
  if (loading) {
    return (
      <div className="vault-loading">
        <div className="vault-spinner" />
        <div className="vault-empty-desc">加载中…</div>
      </div>
    )
  }

  // 错误态
  if (error) {
    return (
      <div className="vault-error">
        <AlertCircle size={28} className="vault-error-icon" />
        <div className="vault-error-title">加载失败</div>
        <div className="vault-error-desc">{error}</div>
        <Button type="button" variant="outline" size="sm" onClick={() => fetchList()}>
          重试
        </Button>
      </div>
    )
  }

  // 空态
  if (items.length === 0) {
    return (
      <div className="vault-empty">
        <KeyRound size={28} className="vault-empty-icon" />
        <div className="vault-empty-title">暂无凭据</div>
        <div className="vault-empty-desc">创建密码、私钥或 SSH 证书以辅助服务器登录</div>
        <Button type="button" size="sm" onClick={onCreate} className="pf-btn-submit">
          <Plus size={14} /> 新建凭据
        </Button>
      </div>
    )
  }

  // 正常态
  return (
    <div className="vault-grid">
      {items.map((item) => (
        <VaultItemRow key={item.id} item={item} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </div>
  )
}
