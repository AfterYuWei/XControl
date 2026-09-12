import { useEffect, useMemo, useRef, useState } from 'react'
import { KeyRound, Plus, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { MobileHeader } from './MobileHeader'
import { MobileEmpty } from './MobileEmpty'
import { MobileSheet } from './MobileSheet'
import { VaultRow } from './VaultRow'
import { useHeaderCollapse } from './useHeaderCollapse'
import { useVaultStore } from '@/store/vault'
import { vaultApi } from '@/api/vault'
import { VaultFormDialog } from '@/components/Vault/VaultFormDialog'
import { VaultGenerateDialog } from '@/components/Vault/VaultGenerateDialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { VaultFilterType, VaultItem, ProfileRef } from '@/types/vault'

const SEGMENT_OPTIONS: Array<{ value: VaultFilterType; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'password', label: '密码' },
  { value: 'private_key', label: '私钥' },
]

interface DeleteTarget {
  item: VaultItem
  refs: ProfileRef[]
}

export function MobileVaultPage() {
  const { items, loading, error, filterType, searchQuery, setFilterType, setSearchQuery, fetchList, remove } = useVaultStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  const collapsed = useHeaderCollapse(scrollRef)

  const [hostQuery, setHostQuery] = useState('')
  const [editing, setEditing] = useState<VaultItem | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [genOpen, setGenOpen] = useState(false)
  const [sheetItem, setSheetItem] = useState<VaultItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    void fetchList()
  }, [fetchList])

  // 防抖同步到 store（后端查询）；列表渲染用本地即时过滤，输入零感知延迟
  useEffect(() => {
    if (hostQuery === searchQuery) return
    const timer = window.setTimeout(() => setSearchQuery(hostQuery), 250)
    return () => window.clearTimeout(timer)
  }, [hostQuery, searchQuery, setSearchQuery])

  // 本地即时过滤（类型 + 关键词），后端同步仅保证数据完整
  const visibleItems = useMemo(() => {
    const q = hostQuery.trim().toLowerCase()
    return items.filter((item) => {
      if (filterType !== 'all' && item.type !== filterType) return false
      if (!q) return true
      return (
        item.name.toLowerCase().includes(q)
        || item.username.toLowerCase().includes(q)
        || item.remark.toLowerCase().includes(q)
      )
    })
  }, [items, filterType, hostQuery])

  const openEdit = (item: VaultItem | null) => {
    setEditing(item)
    setFormOpen(true)
  }

  const requestDelete = async (item: VaultItem) => {
    try {
      const refs = await vaultApi.references(item.id)
      setDeleteTarget({ item, refs: refs ?? [] })
    } catch {
      toast.error('查询引用失败')
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget || deleteTarget.refs.length > 0) return
    setDeleting(true)
    try {
      await remove(deleteTarget.item.id)
      setDeleteTarget(null)
    } catch (err) {
      toast.error((err as Error).message || '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="m-page">
      <MobileHeader
        variant="large"
        title="密码库"
        collapsed={collapsed}
        trailing={(
          <>
            <button
              type="button"
              className="m-round-btn"
              aria-label="生成密钥对"
              title="生成密钥对"
              onClick={() => setGenOpen(true)}
            >
              <KeyRound size={18} />
            </button>
            <button
              type="button"
              className="m-round-btn"
              aria-label="新建凭据"
              title="新建凭据"
              onClick={() => openEdit(null)}
            >
              <Plus size={18} />
            </button>
          </>
        )}
      />
      <div className="m-page-scroll" ref={scrollRef}>
        <div className="m-page-body">
          <div className="m-seg" role="radiogroup" aria-label="凭据类型筛选">
            {SEGMENT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={filterType === option.value}
                className={filterType === option.value ? 'is-active' : ''}
                onClick={() => setFilterType(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <label className="m-search">
            <Search aria-hidden="true" />
            <input
              type="search"
              value={hostQuery}
              placeholder="搜索名称/用户名/备注…"
              aria-label="搜索凭据"
              onChange={(event) => setHostQuery(event.target.value)}
            />
            {hostQuery && (
              <button type="button" className="m-search-clear" aria-label="清除搜索" onClick={() => setHostQuery('')}>
                <X size={14} />
              </button>
            )}
          </label>

          {loading && items.length === 0 ? (
            <div className="m-loading">加载中…</div>
          ) : error && items.length === 0 ? (
            <MobileEmpty title="加载失败" description={error} />
          ) : items.length === 0 ? (
            // 空态：仅文字提示，入口收敛到页头操作
            <MobileEmpty title="暂无凭据" description="创建密码、私钥或 SSH 证书以辅助服务器登录。" />
          ) : visibleItems.length === 0 ? (
            <MobileEmpty icon={Search} title="未找到相关凭据" description="试试其他名称、用户名或备注。" />
          ) : (
            <div className="m-card">
              {visibleItems.map((item) => (
                <VaultRow
                  key={item.id}
                  item={item}
                  onOpen={() => openEdit(item)}
                  onRequestDelete={() => void requestDelete(item)}
                  onLongPress={() => setSheetItem(item)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <MobileSheet
        open={sheetItem !== null}
        onOpenChange={(open) => { if (!open) setSheetItem(null) }}
        title={sheetItem?.name || '未命名'}
        items={sheetItem ? [
          { id: 'edit', label: '编辑', onSelect: () => openEdit(sheetItem) },
          { id: 'delete', label: '删除', danger: true, onSelect: () => void requestDelete(sheetItem) },
        ] : []}
      />

      <VaultFormDialog
        key={formOpen ? `vault-${editing?.id || 'new'}` : 'vault-closed'}
        open={formOpen}
        onOpenChange={setFormOpen}
        item={editing}
      />

      <VaultGenerateDialog open={genOpen} onOpenChange={setGenOpen} />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
      >
        <AlertDialogContent>
          {deleteTarget && deleteTarget.refs.length > 0 ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>无法删除</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div>
                    <span>凭据「{deleteTarget.item.name || '未命名'}」被以下连接引用，请先解除引用：</span>
                    <ul className="m-vault-refs">
                      {deleteTarget.refs.map((ref) => (
                        <li key={ref.id}>{ref.name}</li>
                      ))}
                    </ul>
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogAction>知道了</AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>删除凭据？</AlertDialogTitle>
                <AlertDialogDescription>
                  确定删除凭据「{deleteTarget?.item.name || '未命名'}」？此操作不可撤销。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-white hover:bg-destructive/90"
                  disabled={deleting}
                  onClick={() => void confirmDelete()}
                >
                  {deleting ? '删除中…' : '删除'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
