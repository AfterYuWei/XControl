import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useProfileStore } from '@/store/profile'
import { toast } from 'sonner'
import { GROUP_ICONS } from '@/lib/groupIcons'
import type { Group } from '@/types/group'

interface GroupFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  group?: Group | null
  /** Preset parent when creating a sub-group via context menu. */
  defaultParentId?: string
}

export function GroupForm({ open, onOpenChange, group, defaultParentId }: GroupFormProps) {
  const { groups, createGroup, updateGroup } = useProfileStore()
  const isEditing = !!group

  const [name, setName] = useState(group?.name ?? '')
  const [parentId, setParentId] = useState(group?.parent_id ?? defaultParentId ?? '')
  const [icon, setIcon] = useState(group?.icon ?? 'folder')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('请输入分组名称')
      return
    }
    setLoading(true)
    setError('')
    try {
      if (isEditing && group) {
        await updateGroup(group.id, {
          name: name.trim(),
          parent_id: parentId,
          icon,
        })
        toast.success('分组已更新')
      } else {
        await createGroup({ name: name.trim(), parent_id: parentId, icon })
        toast.success('分组已创建')
      }
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message || '操作失败')
    } finally {
      setLoading(false)
    }
  }

  // Parent options exclude the editing group itself and its descendants to
  // avoid cycles.
  const parentOptions = [
    { value: '', label: '无（顶级分组）' },
    ...groups
      .filter((g) => !isEditing || g.id !== group?.id)
      .map((g) => ({ value: g.id, label: g.name })),
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)} className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? '编辑分组' : '新建分组'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="group-name">名称</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="生产环境"
              autoFocus
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="group-parent">父分组</Label>
            <Select
              options={parentOptions}
              value={parentId}
              onChange={setParentId}
            />
          </div>

          <div className="space-y-2">
            <Label>图标</Label>
            <div className="flex flex-wrap gap-1.5">
              {GROUP_ICONS.map((def) => {
                const Selected = def.Icon
                const active = (icon || 'folder') === def.key
                return (
                  <button
                    key={def.key}
                    type="button"
                    title={def.label}
                    onClick={() => setIcon(def.key)}
                    className={`flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                      active
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    }`}
                    aria-label={`选择图标 ${def.label}`}
                    aria-pressed={active}
                  >
                    <Selected size={15} />
                  </button>
                )
              })}
            </div>
          </div>

          {error && <div className="text-sm text-destructive">{error}</div>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? '保存中...' : isEditing ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
