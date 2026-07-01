import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useProfileStore } from '@/store/profile'
import { SERVER_ICONS, resolveServerIcon } from '@/lib/serverIcons'
import { VaultSelectButton } from '@/components/Vault/VaultSelectButton'
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
        auth_type: profile.auth_type as 'password' | 'key' | 'vault',
        icon: profile.icon || 'server',
        vault_id: profile.vault_id || '',
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
      vault_id: '',
      password: '',
      private_key: '',
      group_id: presetGroupId || '',
      tags: [],
      note: '',
    }
  })

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Icon popover state
  const [iconOpen, setIconOpen] = useState(false)
  const iconBtnRef = useRef<HTMLButtonElement>(null)
  const iconPopoverRef = useRef<HTMLDivElement>(null)

  const closeIconPopover = useCallback(() => setIconOpen(false), [])

  useEffect(() => {
    if (!iconOpen) return
    const handle = (e: MouseEvent) => {
      if (
        iconBtnRef.current && !iconBtnRef.current.contains(e.target as Node) &&
        iconPopoverRef.current && !iconPopoverRef.current.contains(e.target as Node)
      ) {
        closeIconPopover()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeIconPopover()
    }
    document.addEventListener('mousedown', handle)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', handle)
      document.removeEventListener('keydown', onKey)
    }
  }, [iconOpen, closeIconPopover])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      // 根据认证方式清理对侧字段：vault 模式只发 vault_id，inline 模式清 vault_id
      const payload: ProfileCreateRequest = { ...form }
      if (payload.auth_type === 'vault') {
        payload.password = ''
        payload.private_key = ''
        payload.passphrase = ''
      } else {
        payload.vault_id = ''
      }
      if (isEditing && profile) {
        await updateProfile(profile.id, payload)
      } else {
        await createProfile(payload)
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
    { value: 'vault', label: '从 Vault 选择' },
  ]

  const CurrentIcon = resolveServerIcon(form.icon)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)} className="max-w-lg">
        {/* Header — title left, close button fixed top-right */}
        <DialogHeader className="mb-6">
          <DialogTitle>{isEditing ? '编辑连接' : '新建连接'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} id="profile-form" className="pf-form">
          {/* ── 名称（带图标前缀） ── */}
          <div className="pf-field">
            <Label htmlFor="name" className="pf-label">名称</Label>
            <div className="pf-input-group">
              {/* 图标前缀 — 点击弹出 Popover 选择 */}
              <div className="pf-icon-prefix-wrap">
                <button
                  ref={iconBtnRef}
                  type="button"
                  className="pf-icon-prefix"
                  onClick={() => setIconOpen((v) => !v)}
                  aria-label="选择服务器图标"
                  aria-expanded={iconOpen}
                  title="点击更换图标"
                >
                  <CurrentIcon size={15} />
                </button>
                {iconOpen && (
                  <div ref={iconPopoverRef} className="pf-icon-popover" role="dialog">
                    <div className="pf-icon-popover-title">选择图标</div>
                    <div className="pf-icon-popover-grid">
                      {SERVER_ICONS.map((def) => {
                        const Icon = def.Icon
                        const active = (form.icon || 'server') === def.key
                        return (
                          <button
                            key={def.key}
                            type="button"
                            title={def.label}
                            onClick={() => {
                              setForm({ ...form, icon: def.key })
                              closeIconPopover()
                            }}
                            className={`pf-icon-popover-cell ${active ? 'active' : ''}`}
                            aria-label={`选择图标 ${def.label}`}
                            aria-pressed={active}
                          >
                            <Icon size={16} />
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="生产服务器"
                required
                className="pf-input-mono"
              />
            </div>
          </div>

          {/* ── 主机 + 端口（3:1 网格） ── */}
          <div className="pf-grid-2">
            <div className="pf-field">
              <Label htmlFor="host" className="pf-label">主机</Label>
              <Input
                id="host"
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
                placeholder="192.168.1.100"
                required
                className="pf-input-mono"
              />
            </div>
            <div className="pf-field">
              <Label htmlFor="port" className="pf-label">端口</Label>
              <Input
                id="port"
                type="number"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: parseInt(e.target.value) || 22 })}
                className="pf-input-mono"
              />
            </div>
          </div>

          {/* ── 用户名 + 认证方式（1:1 网格） ── */}
          <div className="pf-grid-2 pf-grid-equal">
            <div className="pf-field">
              <Label htmlFor="username" className="pf-label">用户名</Label>
              <Input
                id="username"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder="root"
                required
                className="pf-input-mono"
              />
            </div>
            <div className="pf-field">
              <Label className="pf-label">认证方式</Label>
              <Select
                options={authOptions}
                value={form.auth_type}
                onChange={(v) => setForm({ ...form, auth_type: v as 'password' | 'key' | 'vault' })}
              />
            </div>
          </div>

          {/* ── 凭据（通栏）：vault 模式显示选择器，否则显示密码/私钥 ── */}
          <div className="pf-field">
            {form.auth_type === 'vault' ? (
              <>
                <Label className="pf-label">凭据选择</Label>
                <VaultSelectButton
                  vaultId={form.vault_id}
                  onChange={(item) => setForm({ ...form, vault_id: item.id, username: item.username || form.username })}
                />
              </>
            ) : (
              <>
                <Label htmlFor="password" className="pf-label">
                  {form.auth_type === 'password' ? '密码' : '私钥'}
                </Label>
                {form.auth_type === 'password' ? (
                  <Input
                    id="password"
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder={isEditing ? '留空则不修改' : ''}
                    className="pf-input-mono"
                  />
                ) : (
                  <Textarea
                    id="private_key"
                    value={form.private_key}
                    onChange={(e) => setForm({ ...form, private_key: e.target.value })}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    rows={3}
                    className="pf-input-mono pf-key-textarea"
                  />
                )}
              </>
            )}
          </div>

          {/* ── 分组（通栏） ── */}
          <div className="pf-field">
            <Label className="pf-label">分组</Label>
            <Select
              options={groupOptions}
              value={form.group_id || ''}
              onChange={(v) => setForm({ ...form, group_id: v })}
            />
          </div>

          {/* ── 备注（通栏文本域） ── */}
          <div className="pf-field">
            <Label htmlFor="note" className="pf-label">备注</Label>
            <Textarea
              id="note"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="可选备注信息"
              rows={3}
            />
          </div>

          {error && (
            <div className="pf-error">{error}</div>
          )}
        </form>

        {/* Footer — 取消左对齐、创建右对齐 */}
        <div className="pf-footer">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="pf-btn-cancel"
          >
            取消
          </Button>
          <Button
            type="submit"
            form="profile-form"
            disabled={loading}
            className="pf-btn-submit"
          >
            {loading ? '保存中...' : isEditing ? '保存' : '创建'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
