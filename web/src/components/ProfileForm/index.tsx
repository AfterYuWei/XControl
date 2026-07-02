import { useCallback, useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, Upload } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useProfileStore } from '@/store/profile'
import { SERVER_ICONS, resolveServerIcon } from '@/lib/serverIcons'
import { VaultSelectButton } from '@/components/Vault/VaultSelectButton'
import type { Profile, ProfileCreateRequest } from '@/types/profile'
import type { VaultItem } from '@/types/vault'

interface ProfileFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile?: Profile | null
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
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [iconOpen, setIconOpen] = useState(false)
  const [uploadingKey, setUploadingKey] = useState(false)
  const [selectedVaultItem, setSelectedVaultItem] = useState<VaultItem | null>(null)
  const [vaultUsernameDirty, setVaultUsernameDirty] = useState(false)
  const [lastAppliedVaultUsername, setLastAppliedVaultUsername] = useState('')
  const iconBtnRef = useRef<HTMLButtonElement>(null)
  const iconPopoverRef = useRef<HTMLDivElement>(null)
  const privateKeyFileRef = useRef<HTMLInputElement>(null)

  const closeIconPopover = useCallback(() => setIconOpen(false), [])

  useEffect(() => {
    if (!iconOpen) return

    const handleMouseDown = (event: MouseEvent) => {
      if (
        iconBtnRef.current &&
        !iconBtnRef.current.contains(event.target as Node) &&
        iconPopoverRef.current &&
        !iconPopoverRef.current.contains(event.target as Node)
      ) {
        closeIconPopover()
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeIconPopover()
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [iconOpen, closeIconPopover])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')

    try {
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

  const handlePrivateKeyUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setUploadingKey(true)
    setError('')
    try {
      const text = await file.text()
      setForm((prev) => ({ ...prev, private_key: text }))
    } catch {
      setError('私钥文件读取失败')
    } finally {
      setUploadingKey(false)
      event.target.value = ''
    }
  }

  const groupOptions = [
    { value: '', label: '无分组' },
    ...groups.map((group) => ({ value: group.id, label: `${group.icon} ${group.name}` })),
  ]

  const authOptions = [
    { value: 'password', label: '密码' },
    { value: 'key', label: '私钥' },
    { value: 'vault', label: '从 Vault 选择' },
  ]

  const CurrentIcon = resolveServerIcon(form.icon)
  const showPasswordAuth = form.auth_type === 'password'
  const showKeyAuth = form.auth_type === 'key'
  const vaultHasUsername = !!selectedVaultItem?.username?.trim()
  const vaultUsernameHelpText = selectedVaultItem
    ? vaultHasUsername
      ? '已从 Vault 回显用户名，可按需修改，仅作用于当前服务器。'
      : '当前 Vault 凭据未设置用户名，请在此填写服务器登录用户名。'
    : '选择 Vault 凭据后，请确认当前服务器使用的登录用户名。'

  const handleVaultSelection = (item: VaultItem) => {
    const incomingUsername = item.username?.trim() || ''
    const currentUsername = form.username.trim()
    const shouldApplyVaultUsername =
      incomingUsername !== '' &&
      (!vaultUsernameDirty || currentUsername === '' || form.username === lastAppliedVaultUsername)

    setLastAppliedVaultUsername(incomingUsername)
    setForm((prev) => ({
      ...prev,
      vault_id: item.id,
      username: shouldApplyVaultUsername ? incomingUsername : prev.username,
    }))

    if (shouldApplyVaultUsername) {
      setVaultUsernameDirty(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)} className="max-w-lg">
        <DialogHeader className="mb-6">
          <DialogTitle>{isEditing ? '编辑连接' : '新建连接'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} id="profile-form" className="pf-form">
          <div className="pf-field">
            <Label htmlFor="name" className="pf-label">
              名称
            </Label>
            <div className="pf-input-group">
              <div className="pf-icon-prefix-wrap">
                <button
                  ref={iconBtnRef}
                  type="button"
                  className="pf-icon-prefix"
                  onClick={() => setIconOpen((value) => !value)}
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
                      {SERVER_ICONS.map((definition) => {
                        const Icon = definition.Icon
                        const active = (form.icon || 'server') === definition.key
                        return (
                          <button
                            key={definition.key}
                            type="button"
                            title={definition.label}
                            onClick={() => {
                              setForm({ ...form, icon: definition.key })
                              closeIconPopover()
                            }}
                            className={`pf-icon-popover-cell ${active ? 'active' : ''}`}
                            aria-label={`选择图标 ${definition.label}`}
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
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="生产服务器"
                required
                className="pf-input-mono"
              />
            </div>
          </div>

          <div className="pf-grid-2">
            <div className="pf-field">
              <Label htmlFor="host" className="pf-label">
                主机
              </Label>
              <Input
                id="host"
                value={form.host}
                onChange={(event) => setForm({ ...form, host: event.target.value })}
                placeholder="192.168.1.100"
                required
                className="pf-input-mono"
              />
            </div>
            <div className="pf-field">
              <Label htmlFor="port" className="pf-label">
                端口
              </Label>
              <Input
                id="port"
                type="number"
                value={form.port}
                onChange={(event) => setForm({ ...form, port: parseInt(event.target.value, 10) || 22 })}
                className="pf-input-mono"
              />
            </div>
          </div>

          <div className="pf-field">
            <Label className="pf-label">认证方式</Label>
            <Select
              options={authOptions}
              value={form.auth_type}
              onChange={(value) => setForm({ ...form, auth_type: value as 'password' | 'key' | 'vault' })}
            />
          </div>

          {form.auth_type === 'vault' ? (
            <div className="pf-field">
              <Label className="pf-label">凭据选择</Label>
              <VaultSelectButton
                vaultId={form.vault_id}
                onItemResolved={setSelectedVaultItem}
                onChange={handleVaultSelection}
              />
              <div className="pf-help-text">{vaultUsernameHelpText}</div>
              <div className="pf-field" style={{ marginTop: '12px' }}>
                <Label htmlFor="vault-username" className="pf-label">
                  用户名
                </Label>
                <Input
                  id="vault-username"
                  value={form.username}
                  onChange={(event) => {
                    setVaultUsernameDirty(true)
                    setForm({ ...form, username: event.target.value })
                  }}
                  placeholder="root"
                  required
                  className="pf-input-mono"
                />
              </div>
            </div>
          ) : (
            <>
              {showPasswordAuth && (
                <div className="pf-grid-2 pf-grid-equal">
                  <div className="pf-field">
                    <Label htmlFor="username" className="pf-label">
                      用户名
                    </Label>
                    <Input
                      id="username"
                      value={form.username}
                      onChange={(event) => setForm({ ...form, username: event.target.value })}
                      placeholder="root"
                      required
                      className="pf-input-mono"
                    />
                  </div>
                  <div className="pf-field">
                    <Label htmlFor="password" className="pf-label">
                      密码
                    </Label>
                    <div className="pf-input-group pf-input-group-action">
                      <Input
                        id="password"
                        type={passwordVisible ? 'text' : 'password'}
                        value={form.password}
                        onChange={(event) => setForm({ ...form, password: event.target.value })}
                        placeholder={isEditing ? '留空则不修改' : ''}
                        className="pf-input-mono"
                      />
                      <button
                        type="button"
                        className="pf-inline-action"
                        onClick={() => setPasswordVisible((value) => !value)}
                        aria-label={passwordVisible ? '隐藏密码' : '显示密码'}
                        title={passwordVisible ? '隐藏密码' : '显示密码'}
                      >
                        {passwordVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {showKeyAuth && (
                <>
                  <div className="pf-field">
                    <Label htmlFor="username" className="pf-label">
                      用户名
                    </Label>
                    <Input
                      id="username"
                      value={form.username}
                      onChange={(event) => setForm({ ...form, username: event.target.value })}
                      placeholder="root"
                      required
                      className="pf-input-mono"
                    />
                  </div>

                  <div className="pf-field">
                    <div className="pf-field-head">
                      <Label htmlFor="private_key" className="pf-label">
                        私钥
                      </Label>
                      <button
                        type="button"
                        className="pf-upload-btn"
                        onClick={() => privateKeyFileRef.current?.click()}
                        disabled={uploadingKey}
                      >
                        <Upload size={13} />
                        {uploadingKey ? '读取中...' : '上传文件'}
                      </button>
                    </div>
                    <input
                      ref={privateKeyFileRef}
                      type="file"
                      accept=".pem,.key,.txt,*/*"
                      className="hidden"
                      onChange={handlePrivateKeyUpload}
                    />
                    <Textarea
                      id="private_key"
                      value={form.private_key}
                      onChange={(event) => setForm({ ...form, private_key: event.target.value })}
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                      rows={4}
                      className="pf-input-mono pf-key-textarea"
                    />
                  </div>
                </>
              )}
            </>
          )}

          <div className="pf-field">
            <Label className="pf-label">分组</Label>
            <Select
              options={groupOptions}
              value={form.group_id || ''}
              onChange={(value) => setForm({ ...form, group_id: value })}
            />
          </div>

          <div className="pf-field">
            <Label htmlFor="note" className="pf-label">
              备注
            </Label>
            <Textarea
              id="note"
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
              placeholder="可选备注信息"
              rows={3}
            />
          </div>

          {error && <div className="pf-error">{error}</div>}
        </form>

        <div className="pf-footer">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="pf-btn-cancel">
            取消
          </Button>
          <Button type="submit" form="profile-form" disabled={loading} className="pf-btn-submit">
            {loading ? '保存中...' : isEditing ? '保存' : '创建'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
