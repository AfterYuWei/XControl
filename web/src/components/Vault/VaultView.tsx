import { useState, useEffect } from 'react'
import { Plus, KeyRound, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useVaultStore } from '@/store/vault'
import { notify } from '@/store/notify'
import { VaultList } from './VaultList'
import { VaultFormDialog } from './VaultFormDialog'
import { VaultGenerateDialog } from './VaultGenerateDialog'
import type { VaultItem, ProfileRef } from '@/types/vault'

const FILTER_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'password', label: '密码' },
  { value: 'private_key', label: '私钥' },
  { value: 'ssh_certificate', label: 'SSH 证书' },
]

interface DeleteTarget {
  item: VaultItem
  refs: ProfileRef[]
}

export function VaultView() {
  const { filterType, searchQuery, setFilterType, setSearchQuery, fetchList, remove } = useVaultStore()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<VaultItem | null>(null)
  const [genOpen, setGenOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    fetchList()
  }, [fetchList])

  const handleCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }

  const handleEdit = (item: VaultItem) => {
    setEditing(item)
    setFormOpen(true)
  }

  const handleDelete = (item: VaultItem, refs: ProfileRef[]) => {
    setDeleteTarget({ item, refs })
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await remove(deleteTarget.item.id)
      setDeleteTarget(null)
    } catch (err) {
      const msg = (err as { error?: { message?: string } })?.error?.message ?? (err as Error).message
      notify.error(msg || '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="vault-view">
      {/* 工具栏 */}
      <div className="vault-toolbar">
        <span className="vault-toolbar-title">
          <KeyRound size={14} style={{ verticalAlign: '-2px', marginRight: '4px' }} />
          Vault
        </span>
        <div className="vault-toolbar-filter">
          <Select
            options={FILTER_OPTIONS}
            value={filterType}
            onChange={(v) => setFilterType(v as typeof filterType)}
          />
        </div>
        <input
          type="text"
          className="vault-toolbar-search"
          placeholder="搜索名称/备注…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <div className="vault-toolbar-actions">
          <Button type="button" variant="outline" size="sm" onClick={() => setGenOpen(true)}>
            生成密钥对
          </Button>
          <Button type="button" size="sm" onClick={handleCreate} className="pf-btn-submit">
            <Plus size={14} /> 新建凭据
          </Button>
        </div>
      </div>

      {/* 列表 */}
      <VaultList onEdit={handleEdit} onDelete={handleDelete} onCreate={handleCreate} />

      {/* 创建/编辑弹窗 */}
      <VaultFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        item={editing}
      />

      {/* 密钥对生成弹窗 */}
      <VaultGenerateDialog open={genOpen} onOpenChange={setGenOpen} />

      {/* 删除确认弹窗 */}
      <Dialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent onClose={() => setDeleteTarget(null)} className="max-w-md">
          <DialogHeader className="mb-4">
            <DialogTitle>
              {deleteTarget && deleteTarget.refs.length > 0 ? '无法删除' : '确认删除'}
            </DialogTitle>
          </DialogHeader>

          {deleteTarget && deleteTarget.refs.length > 0 ? (
            <>
              <div className="vault-delete-refs">
                <div className="vault-delete-refs-title">
                  <AlertTriangle size={12} style={{ verticalAlign: '-2px', marginRight: '4px' }} />
                  该凭据被以下连接引用，无法删除
                </div>
                <ul className="vault-delete-refs-list">
                  {deleteTarget.refs.map((ref) => (
                    <li key={ref.id}>{ref.name}</li>
                  ))}
                </ul>
              </div>
              <div className="pf-footer">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDeleteTarget(null)}
                  className="pf-btn-cancel"
                >
                  知道了
                </Button>
              </div>
            </>
          ) : (
            <>
              <p style={{ fontSize: '13px', color: 'var(--fg-2)', marginBottom: '16px' }}>
                确认删除凭据「{deleteTarget?.item.name || '未命名'}」？此操作不可撤销。
              </p>
              <div className="pf-footer">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDeleteTarget(null)}
                  className="pf-btn-cancel"
                >
                  取消
                </Button>
                <Button
                  type="button"
                  onClick={handleConfirmDelete}
                  disabled={deleting}
                  className="pf-btn-submit"
                  style={{ background: 'var(--red)', color: '#fff' }}
                >
                  {deleting ? '删除中…' : '删除'}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
