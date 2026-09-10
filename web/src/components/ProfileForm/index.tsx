import { useCallback, useRef, useState } from 'react'
import { CheckCircle2, Eye, EyeOff, LoaderCircle, Network, ShieldAlert, Upload, XCircle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useProfileStore } from '@/store/profile'
import { profileApi } from '@/api/profile'
import { SERVER_ICONS, ServerIcon } from '@/lib/serverIcons'
import { applyVaultUsernameToProfile } from '@/lib/vaultUsername'
import { jumpProfileCandidates, newProxyInput, proxyInputFromProfile } from '@/lib/profileProxy'
import { VaultSelectButton } from '@/components/Vault/VaultSelectButton'
import type { Profile, ProfileCreateRequest, ProfileProxyInput, ProfileTestResult, ProxyType } from '@/types/profile'
import type { VaultItem } from '@/types/vault'
import { isMobileRuntime } from '@/lib/platform'
import { pickDocumentText } from '@/api/document'

interface ProfileFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile?: Profile | null
  presetGroupId?: string
}

export function ProfileForm({ open, onOpenChange, profile, presetGroupId }: ProfileFormProps) {
  const { profiles, groups, createProfile, updateProfile } = useProfileStore()
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
        proxy: proxyInputFromProfile(profile.proxy),
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
      username: '',
      auth_type: 'password',
      icon: 'server',
      vault_id: '',
      proxy: { type: 'direct' },
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
  const [proxyPasswordVisible, setProxyPasswordVisible] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProfileTestResult | null>(null)
  const [iconOpen, setIconOpen] = useState(false)
  const [uploadingKey, setUploadingKey] = useState(false)
  const [selectedVaultItem, setSelectedVaultItem] = useState<VaultItem | null>(null)
  const autoVaultUsernameRef = useRef('')
  const privateKeyFileRef = useRef<HTMLInputElement>(null)

  const closeIconPopover = useCallback(() => setIconOpen(false), [])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')

    try {
      const payload: ProfileCreateRequest = { ...form, username: form.username.trim() }
      if (!payload.username) {
        setError('用户名不能为空')
        setLoading(false)
        return
      }
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
      const apiMessage = (err as { error?: { message?: string } })?.error?.message
      setError(apiMessage || (err as Error).message || '操作失败')
    } finally {
      setLoading(false)
    }
  }

  const runConnectionTest = async () => {
    setTesting(true)
    setTestResult(null)
    setError('')
    try {
      const payload: ProfileCreateRequest = { ...form, username: form.username.trim() }
      if (!payload.host.trim() || !payload.username) {
        setError('请先填写主机和用户名')
        return
      }
      if (payload.auth_type === 'vault') {
        payload.password = ''
        payload.private_key = ''
        payload.passphrase = ''
      } else {
        payload.vault_id = ''
      }
      const result = isEditing && profile
        ? await profileApi.test(profile.id, payload)
        : await profileApi.testNew(payload)
      setTestResult(result)
    } catch (err) {
      const apiMessage = (err as { error?: { message?: string } })?.error?.message
      setError(apiMessage || (err as Error).message || '连接测试失败')
    } finally {
      setTesting(false)
    }
  }

  const confirmTestHostKey = async (profileId: string, fingerprint: string) => {
    setTesting(true)
    setError('')
    try {
      await profileApi.confirmHostKey(profileId, fingerprint)
      await runConnectionTest()
    } catch (err) {
      const apiMessage = (err as { error?: { message?: string } })?.error?.message
      setError(apiMessage || '确认主机指纹失败')
      setTesting(false)
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

  const pickPrivateKey = async () => {
    if (!isMobileRuntime()) {
      privateKeyFileRef.current?.click()
      return
    }
    setUploadingKey(true)
    setError('')
    try {
      const text = await pickDocumentText(['application/x-pem-file', 'text/plain'], 1024 * 1024)
      if (text !== null) setForm((previous) => ({ ...previous, private_key: text }))
    } catch {
      setError('私钥文件读取失败')
    } finally {
      setUploadingKey(false)
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

  const proxyOptions = [
    { value: 'direct', label: '直连' },
    { value: 'socks5', label: 'SOCKS5' },
    { value: 'http', label: 'HTTP CONNECT' },
    { value: 'jump', label: 'SSH 跳板机' },
  ]
  const jumpProfileOptions = [
    { value: '', label: '请选择跳板机' },
    ...jumpProfileCandidates(profiles, profile?.id)
      .map((item) => ({ value: item.id, label: `${item.name} · ${item.username}@${item.host}:${item.port}` })),
  ]
  const proxy = form.proxy || { type: 'direct' }

  const showPasswordAuth = form.auth_type === 'password'
  const showKeyAuth = form.auth_type === 'key'
  const isPasswordVault = form.auth_type === 'vault' && selectedVaultItem?.type === 'password'
  const vaultUsernameHelpText = selectedVaultItem
    ? selectedVaultItem.type === 'password'
      ? selectedVaultItem.username
        ? '密码凭据已绑定用户名，服务器中不可单独修改。'
        : '该密码凭据缺少用户名，请先前往 Vault 补充。'
      : '私钥不绑定用户，请填写当前服务器的登录用户名。'
    : '选择 Vault 凭据；服务器登录用户名始终需要确认。'

  const applyVaultItem = useCallback((item: VaultItem, updateVaultId: boolean) => {
    const previousAutoUsername = autoVaultUsernameRef.current
    setSelectedVaultItem(item)
    setForm((prev) => {
      const next = applyVaultUsernameToProfile(item, prev.username, previousAutoUsername)
      autoVaultUsernameRef.current = next.autoUsername
      return {
        ...prev,
        vault_id: updateVaultId ? item.id : prev.vault_id,
        username: next.username,
      }
    })
  }, [])

  const handleVaultSelection = useCallback((item: VaultItem) => {
    applyVaultItem(item, true)
  }, [applyVaultItem])

  const handleVaultResolved = useCallback((item: VaultItem | null) => {
    if (item) applyVaultItem(item, false)
    else setSelectedVaultItem(null)
  }, [applyVaultItem])

  const handleAuthTypeChange = (value: string) => {
    const nextAuthType = value as 'password' | 'key' | 'vault'
    const previousAutoUsername = autoVaultUsernameRef.current
    if (nextAuthType !== 'vault') autoVaultUsernameRef.current = ''
    setForm((prev) => ({
      ...prev,
      auth_type: nextAuthType,
      username:
        nextAuthType === 'vault' && selectedVaultItem?.type === 'password'
          ? selectedVaultItem.username.trim()
          : previousAutoUsername && prev.username === previousAutoUsername
            ? ''
            : prev.username,
    }))
  }

  const handleProxyTypeChange = (value: string) => {
    const type = value as ProxyType
    setForm((prev) => ({ ...prev, proxy: newProxyInput(type) }))
    setTestResult(null)
  }

  const updateProxy = (patch: Partial<ProfileProxyInput>) => {
    setForm((prev) => ({ ...prev, proxy: { ...(prev.proxy || { type: 'direct' }), ...patch } }))
    setTestResult(null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[min(760px,calc(100vw-2rem))] max-w-none overflow-y-auto">
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
                <Popover open={iconOpen} onOpenChange={setIconOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="pf-icon-prefix"
                      aria-label="选择服务器图标"
                      title="点击更换图标"
                    >
                      <ServerIcon iconKey={form.icon} size={15} />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="pf-icon-popover w-[220px] p-2.5">
                    <div className="pf-icon-popover-title">选择图标</div>
                    <div className="pf-icon-popover-grid">
                      {SERVER_ICONS.map((definition) => {
                        const Icon = definition.Icon
                        const active = (form.icon || 'server') === definition.key
                        return (
                          <Button
                            key={definition.key}
                            type="button"
                            variant="ghost"
                            size="icon-sm"
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
                          </Button>
                        )
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
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
            <Label htmlFor="username" className="pf-label">
              用户名
            </Label>
            <Input
              id="username"
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
              placeholder="例如：root"
              required
              disabled={isPasswordVault}
              className="pf-input-mono"
            />
          </div>

          <div className="pf-field">
            <Label className="pf-label">认证方式</Label>
            <Select value={form.auth_type} onValueChange={handleAuthTypeChange}>
              <SelectTrigger className="w-full"><SelectValue placeholder="请选择" /></SelectTrigger>
              <SelectContent>{authOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>

          {form.auth_type === 'vault' ? (
            <div className="pf-field">
              <Label className="pf-label">凭据选择</Label>
              <VaultSelectButton
                vaultId={form.vault_id}
                onItemResolved={handleVaultResolved}
                onChange={handleVaultSelection}
              />
              <div className="pf-help-text">{vaultUsernameHelpText}</div>
            </div>
          ) : (
            <>
              {showPasswordAuth && (
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="pf-inline-action"
                      onClick={() => setPasswordVisible((value) => !value)}
                      aria-label={passwordVisible ? '隐藏密码' : '显示密码'}
                      title={passwordVisible ? '隐藏密码' : '显示密码'}
                    >
                      {passwordVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                    </Button>
                  </div>
                </div>
              )}

              {showKeyAuth && (
                <>
                  <div className="pf-field">
                    <div className="pf-field-head">
                      <Label htmlFor="private_key" className="pf-label">
                        私钥
                      </Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="pf-upload-btn"
                        onClick={() => void pickPrivateKey()}
                        disabled={uploadingKey}
                      >
                        <Upload size={13} />
                        {uploadingKey ? '读取中...' : '上传文件'}
                      </Button>
                    </div>
                    <Input
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

          <div className="pf-section-divider" />
          <div className="pf-section-title">
            <Network size={14} />
            SSH 代理
          </div>

          <div className="pf-field">
            <Label className="pf-label">连接方式</Label>
            <Select value={proxy.type} onValueChange={handleProxyTypeChange}>
              <SelectTrigger className="w-full"><SelectValue placeholder="请选择" /></SelectTrigger>
              <SelectContent>{proxyOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>

          {(proxy.type === 'socks5' || proxy.type === 'http') && (
            <>
              <div className="pf-grid-2">
                <div className="pf-field">
                  <Label htmlFor="proxy-host" className="pf-label">代理主机</Label>
                  <Input
                    id="proxy-host"
                    value={proxy.host || ''}
                    onChange={(event) => updateProxy({ host: event.target.value })}
                    placeholder="proxy.example.com"
                    className="pf-input-mono"
                  />
                </div>
                <div className="pf-field">
                  <Label htmlFor="proxy-port" className="pf-label">代理端口</Label>
                  <Input
                    id="proxy-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={proxy.port || (proxy.type === 'socks5' ? 1080 : 8080)}
                    onChange={(event) => updateProxy({ port: Number.parseInt(event.target.value, 10) || undefined })}
                    className="pf-input-mono"
                  />
                </div>
              </div>
              <div className="pf-grid-2 pf-grid-equal">
                <div className="pf-field">
                  <Label htmlFor="proxy-username" className="pf-label">代理用户名</Label>
                  <Input
                    id="proxy-username"
                    value={proxy.username || ''}
                    onChange={(event) => updateProxy({ username: event.target.value })}
                    placeholder="可选"
                    className="pf-input-mono"
                  />
                </div>
                <div className="pf-field">
                  <Label htmlFor="proxy-password" className="pf-label">代理密码</Label>
                  <div className="pf-input-group pf-input-group-action">
                    <Input
                      id="proxy-password"
                      type={proxyPasswordVisible ? 'text' : 'password'}
                      value={proxy.password ?? ''}
                      onChange={(event) => updateProxy({ password: event.target.value })}
                      placeholder={isEditing && profile?.proxy?.has_password ? '已保存，留空则不修改' : '可选'}
                      className="pf-input-mono"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="pf-inline-action"
                      onClick={() => setProxyPasswordVisible((value) => !value)}
                      aria-label={proxyPasswordVisible ? '隐藏代理密码' : '显示代理密码'}
                    >
                      {proxyPasswordVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                    </Button>
                  </div>
                  {isEditing && profile?.proxy?.has_password && proxy.password === undefined && (
                    <Button type="button" variant="link" className="pf-clear-secret" onClick={() => updateProxy({ username: '', password: '' })}>
                      清除代理认证
                    </Button>
                  )}
                </div>
              </div>
              <div className="pf-help-text">目标域名由代理端解析；账号与密码需要同时填写。</div>
            </>
          )}

          {proxy.type === 'jump' && (
            <div className="pf-field">
              <Label className="pf-label">跳板服务器</Label>
              <Select value={proxy.jump_profile_id || '__none__'} onValueChange={(value) => updateProxy({ jump_profile_id: value === '__none__' ? '' : value })}>
                <SelectTrigger className="w-full"><SelectValue placeholder="请选择" /></SelectTrigger>
                <SelectContent>{jumpProfileOptions.map((option) => <SelectItem key={option.value || '__none__'} value={option.value || '__none__'}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
              <div className="pf-help-text">跳板机使用其自身 SSH 凭据和代理配置，支持最多 5 层递归链路。</div>
            </div>
          )}

          {testResult && (
            <div className={`pf-test-result ${testResult.success ? 'success' : 'error'}`}>
              <div className="pf-test-summary">
                {testResult.success ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                <span>{testResult.message}</span>
                <span className="pf-test-latency">{testResult.latency_ms} ms</span>
              </div>
              <div className="pf-test-stages">
                {testResult.stages.map((stage, index) => (
                  <div key={`${stage.stage}-${stage.profile_id}-${index}`} className="pf-test-stage">
                    {stage.status === 'success' ? <CheckCircle2 size={13} /> : <ShieldAlert size={13} />}
                    <div>
                      <div>{stage.profile_name ? `${stage.profile_name}：` : ''}{stage.message}</div>
                      {stage.fingerprint && <div className="pf-test-fingerprint">当前：{stage.fingerprint}</div>}
                      {stage.known_fingerprint && <div className="pf-test-fingerprint">已保存：{stage.known_fingerprint}</div>}
                    </div>
                    {stage.status === 'error' && stage.profile_id && stage.fingerprint && !stage.profile_id.startsWith('draft-') && (
                      <Button
                        type="button"
                        variant="outline"
                        className="pf-confirm-key-btn"
                        disabled={testing}
                        onClick={() => confirmTestHostKey(stage.profile_id!, stage.fingerprint!)}
                      >
                        信任新指纹
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="pf-field">
            <Label className="pf-label">分组</Label>
            <Select value={form.group_id || '__none__'} onValueChange={(value) => setForm({ ...form, group_id: value === '__none__' ? '' : value })}>
              <SelectTrigger className="w-full"><SelectValue placeholder="请选择" /></SelectTrigger>
              <SelectContent>{groupOptions.map((option) => <SelectItem key={option.value || '__none__'} value={option.value || '__none__'}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
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
          <Button type="button" variant="outline" onClick={runConnectionTest} disabled={loading || testing} className="pf-btn-test">
            {testing ? <LoaderCircle size={14} className="animate-spin" /> : <Network size={14} />}
            {testing ? '测试中...' : '测试连接'}
          </Button>
          <div className="pf-footer-spacer" />
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
