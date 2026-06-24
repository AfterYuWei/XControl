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
import { Textarea } from '@/components/ui/textarea'
import { useProfileStore } from '@/store/profile'
import { SERVER_ICONS } from '@/lib/serverIcons'
import type { Profile, ProfileCreateRequest } from '@/types/profile'

interface ProfileFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile?: Profile | null
  /** Preset group when creating a new profile from a group's "+" button. */
  presetGroupId?: string
}

export function ProfileForm({ open, onOpenChange, profile, presetGroupId }: ProfileFormProps) {
  const { groups, createProfile, updateProfile } = useProfileStore()
  const isEditing = !!profile

  const [form, setForm] = useState<ProfileCreateRequest>(() => {
    if (profile) {
      return {
        name: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        auth_type: profile.auth_type as 'password' | 'key',
        icon: profile.icon || 'server',
        password: '',
        private_key: '',
        group_id: profile.group_id || '',
        tags: profile.tags,
        note: profile.note,
      }
    }
    return {
      name: '',
      host: '',
      port: 22,
      username: 'root',
      auth_type: 'password',
      icon: 'server',
      password: '',
      private_key: '',
      group_id: presetGroupId || '',
      tags: [],
      note: '',
    }
  })

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      if (isEditing && profile) {
        await updateProfile(profile.id, form)
      } else {
        await createProfile(form)
      }
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message || '操作失败')
    } finally {
      setLoading(false)
    }
  }

  const groupOptions = [
    { value: '', label: '无分组' },
    ...groups.map((g) => ({ value: g.id, label: `${g.icon} ${g.name}` })),
  ]

  const authOptions = [
    { value: 'password', label: '密码' },
    { value: 'key', label: '私钥' },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)} className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? '编辑连接' : '新建连接'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">名称</Label>
            <Input
              id="name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="生产服务器"
              required
            />
          </div>

          <div className="space-y-2">
            <Label>图标</Label>
            <div className="flex flex-wrap gap-1.5">
              {SERVER_ICONS.map((def) => {
                const Selected = def.Icon
                const active = (form.icon || 'server') === def.key
                return (
                  <button
                    key={def.key}
                    type="button"
                    title={def.label}
                    onClick={() => setForm({ ...form, icon: def.key })}
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

          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="host">主机</Label>
              <Input
                id="host"
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
                placeholder="192.168.1.100"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="port">端口</Label>
              <Input
                id="port"
                type="number"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: parseInt(e.target.value) || 22 })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="username">用户名</Label>
            <Input
              id="username"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="root"
              required
            />
          </div>

          <div className="space-y-2">
            <Label>认证方式</Label>
            <Select
              options={authOptions}
              value={form.auth_type}
              onChange={(e) => setForm({ ...form, auth_type: e.target.value as 'password' | 'key' })}
            />
          </div>

          {form.auth_type === 'password' ? (
            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder={isEditing ? '留空则不修改' : ''}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="private_key">私钥</Label>
              <Textarea
                id="private_key"
                value={form.private_key}
                onChange={(e) => setForm({ ...form, private_key: e.target.value })}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                rows={4}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label>分组</Label>
            <Select
              options={groupOptions}
              value={form.group_id || ''}
              onChange={(e) => setForm({ ...form, group_id: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="note">备注</Label>
            <Input
              id="note"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="可选备注"
            />
          </div>

          {error && (
            <div className="text-sm text-destructive">{error}</div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
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
