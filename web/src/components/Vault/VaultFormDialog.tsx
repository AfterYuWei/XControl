import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Copy, Dices, Download, Eye, EyeOff, FileText, Terminal, Upload } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { vaultApi } from '@/api/vault'
import { toast } from 'sonner'
import { useVaultStore } from '@/store/vault'
import { buildPrivateKeyFilename, buildPublicKeyImportCommand } from '@/lib/vaultKeyActions'
import { normalizeVaultUsername } from '@/lib/vaultUsername'
import { VAULT_TYPE_LABELS, type VaultCreateRequest, type VaultItem, type VaultType } from '@/types/vault'
import { VaultPasswordGenerator } from './VaultPasswordGenerator'

interface VaultFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item?: VaultItem | null
}

interface VaultFormDialogInnerProps {
  item?: VaultItem | null
  onOpenChange: (open: boolean) => void
}

const TYPE_OPTIONS = (Object.keys(VAULT_TYPE_LABELS) as VaultType[]).map((type) => ({
  value: type,
  label: VAULT_TYPE_LABELS[type],
}))

const EMPTY_FORM: VaultCreateRequest = {
  name: '',
  type: 'password',
  username: '',
  remark: '',
  password: '',
  private_key: '',
  public_key: '',
  passphrase: '',
}

function buildInitialForm(item?: VaultItem | null): VaultCreateRequest {
  if (!item) return { ...EMPTY_FORM }

  return {
    name: item.name,
    type: item.type,
    username: item.type === 'password' ? item.username : '',
    remark: item.remark,
    password: '',
    private_key: '',
    public_key: '',
    passphrase: '',
  }
}

function isSameForm(left: VaultCreateRequest, right: VaultCreateRequest): boolean {
  return (
    left.name === right.name &&
    left.type === right.type &&
    left.username === right.username &&
    left.remark === right.remark &&
    left.password === right.password &&
    left.private_key === right.private_key &&
    left.public_key === right.public_key &&
    left.passphrase === right.passphrase
  )
}

async function writeClipboardText(text: string): Promise<void> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // Some desktop/webview contexts expose Clipboard API but deny access.
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()

  try {
    if (!document.execCommand('copy')) throw new Error('Copy command failed')
  } finally {
    textarea.remove()
  }
}

function PasswordEditorSection({
  password,
  isEditing,
  showGenerator,
  onPasswordChange,
  onToggleGenerator,
  onApplyGeneratedPassword,
}: {
  password: string
  isEditing: boolean
  showGenerator: boolean
  onPasswordChange: (value: string) => void
  onToggleGenerator: () => void
  onApplyGeneratedPassword: (password: string) => void
}) {
  const [showPassword, setShowPassword] = useState(false)

  return (
    <section className="vault-form-password-panel">
      <div className="vault-form-password-head">
        <span className="vault-form-password-title">密码</span>
        <div className="vault-form-password-actions">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setShowPassword((current) => !current)}
            className="vault-sheet-inline-btn vault-form-password-toggle"
            title={showPassword ? '隐藏密码' : '显示密码'}
            aria-label={showPassword ? '隐藏密码' : '显示密码'}
          >
            {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onToggleGenerator}
            className="vault-sheet-inline-btn"
          >
            <Dices size={13} />
            {showGenerator ? '收起' : '生成'}
          </Button>
        </div>
      </div>

      <Input
        type={showPassword ? 'text' : 'password'}
        value={password}
        onChange={(event) => onPasswordChange(event.target.value)}
        placeholder="输入密码"
        required
        className="pf-input-mono vault-form-password-input"
      />

      <div className="vault-form-password-hint">
        💡 建议搭配用户名或备注一起保存。推荐长度 16-24 位。{isEditing ? '类型固定，内容可更新。' : '创建后类型不可修改。'}
      </div>

      {showGenerator ? <VaultPasswordGenerator onApply={onApplyGeneratedPassword} /> : null}
    </section>
  )
}

export function VaultFormDialog({ open, onOpenChange, item }: VaultFormDialogProps) {
  const instanceKey = `${item?.id ?? 'new'}:${open ? 'open' : 'closed'}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)} className="vault-sheet-dialog-content vault-form-dialog-content">
        <DialogHeader className="vault-sheet-header">
          <div className="vault-sheet-header-top">
            <div className="vault-sheet-title-wrap">
              <span className="vault-sheet-eyebrow">Vault</span>
              <DialogTitle>{item ? '编辑凭据' : '新建凭据'}</DialogTitle>
            </div>
          </div>
        </DialogHeader>

        {open ? <VaultFormDialogInner key={instanceKey} item={item} onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function VaultFormDialogInner({ item, onOpenChange }: VaultFormDialogInnerProps) {
  const { create, update } = useVaultStore()
  const isEditing = !!item

  const [form, setForm] = useState<VaultCreateRequest>(() => buildInitialForm(item))
  const [initialForm, setInitialForm] = useState<VaultCreateRequest>(() => buildInitialForm(item))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showGenerator, setShowGenerator] = useState(false)
  const [showPrivateKey, setShowPrivateKey] = useState(false)
  const [copyMenuOpen, setCopyMenuOpen] = useState(false)
  const publicKeyFileRef = useRef<HTMLInputElement>(null)
  const privateKeyFileRef = useRef<HTMLInputElement>(null)
  const copyMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!item) return

    vaultApi
      .reveal(item.id)
      .then((credential) => {
        const nextForm: VaultCreateRequest = {
          ...buildInitialForm(item),
          password: credential.password ?? '',
          private_key: credential.private_key ?? '',
          public_key: credential.public_key ?? '',
          passphrase: credential.passphrase ?? '',
        }
        setForm((current) => ({
          ...current,
          ...nextForm,
        }))
        setInitialForm(nextForm)
      })
      .catch(() => toast.warning('加载凭据内容失败，请重新输入'))
  }, [item])

  useEffect(() => {
    if (!copyMenuOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!copyMenuRef.current?.contains(event.target as Node)) {
        setCopyMenuOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCopyMenuOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [copyMenuOpen])

  const readFile = (file: File, field: 'private_key' | 'public_key') => {
    if (file.size > 100 * 1024) {
      toast.warning('文件过大，请控制在 100KB 以内')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      setForm((current) => ({ ...current, [field]: String(reader.result ?? '') }))
      toast.success('文件已导入')
    }
    reader.onerror = () => toast.error('读取文件失败')
    reader.readAsText(file)
  }

  const updateField = <K extends keyof VaultCreateRequest>(key: K, value: VaultCreateRequest[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const canSubmit = !loading && (!isEditing || !isSameForm(form, initialForm))

  const handleExportPrivateKey = () => {
    const privateKey = form.private_key?.trim()
    if (!privateKey) {
      toast.warning('暂无可导出的私钥')
      return
    }

    const blob = new Blob([`${privateKey}\n`], { type: 'application/x-pem-file;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = buildPrivateKeyFilename(form.name)
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    toast.success('私钥文件已导出')
  }

  const handleCopyPublicKey = async (mode: 'content' | 'command') => {
    const publicKey = form.public_key?.trim()
    if (!publicKey) {
      toast.warning('暂无可复制的公钥')
      return
    }

    const text = mode === 'content' ? publicKey : buildPublicKeyImportCommand(publicKey)
    try {
      await writeClipboardText(text)
      setCopyMenuOpen(false)
      toast.success(mode === 'content' ? '公钥内容已复制' : '公钥导入指令已复制')
    } catch {
      toast.error('复制失败，请检查剪贴板权限')
    }
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()

    if (!form.name?.trim()) {
      setError('名称不能为空')
      return
    }
    if (form.type === 'password' && !form.username?.trim()) {
      setError('密码凭据必须设置用户名')
      return
    }

    const payload: VaultCreateRequest = {
      ...form,
      name: form.name.trim(),
      username: normalizeVaultUsername(form.type, form.username),
    }

    setLoading(true)
    setError('')

    try {
      if (isEditing && item) {
        await update(item.id, payload)
      } else {
        await create(payload)
      }

      onOpenChange(false)
    } catch (err) {
      const message = (err as { error?: { message?: string } })?.error?.message ?? (err as Error).message
      setError(message || '操作失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} id="vault-form" className="vault-form vault-sheet-form">
      {/* 基本信息 - 上层 */}
      <section className="vault-form-basic">
        <div className="vault-form-basic-grid">
          <div className="pf-field">
            <Label className="pf-label">名称</Label>
            <Input
              value={form.name}
              onChange={(event) => updateField('name', event.target.value)}
              placeholder="prod-root-key"
              required
              className="pf-input-mono"
            />
          </div>

          <div className="pf-field">
            <Label className="pf-label">类型</Label>
            <Select
              options={TYPE_OPTIONS}
              value={form.type}
              onChange={(value) => updateField('type', value as VaultType)}
              disabled={isEditing}
            />
          </div>

          {form.type === 'password' ? (
            <div className="pf-field">
              <Label className="pf-label">用户名</Label>
              <Input
                value={form.username ?? ''}
                onChange={(event) => updateField('username', event.target.value)}
                placeholder="root"
                required
                className="pf-input-mono"
              />
            </div>
          ) : null}

          <div className="pf-field vault-form-remark">
            <Label className="pf-label">备注（可选）</Label>
            <Input
              value={form.remark ?? ''}
              onChange={(event) => updateField('remark', event.target.value)}
              placeholder="请输入备注..."
            />
          </div>
        </div>
      </section>

      {/* 分隔线 */}
      <div className="vault-form-divider" />

      {/* 凭据详情 - 下层 */}
      <div className="vault-form-credential">
        {form.type === 'password' ? (
          <PasswordEditorSection
            password={form.password ?? ''}
            isEditing={isEditing}
            showGenerator={showGenerator}
            onPasswordChange={(value) => updateField('password', value)}
            onToggleGenerator={() => setShowGenerator((current) => !current)}
            onApplyGeneratedPassword={(password) => {
              updateField('password', password)
              setShowGenerator(false)
            }}
          />
        ) : (
          <>
            <section className="vault-form-key-panel">
              <div className="vault-form-key-head">
                <span className="vault-form-key-title">私钥</span>
                <div className="vault-form-key-actions">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setShowPrivateKey((current) => !current)}
                    className="vault-sheet-inline-btn"
                    title={showPrivateKey ? '隐藏私钥' : '显示私钥'}
                  >
                    {showPrivateKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleExportPrivateKey}
                    disabled={!form.private_key?.trim()}
                    className="vault-sheet-inline-btn"
                    title="导出私钥文件"
                  >
                    <Download size={13} />
                    导出
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => privateKeyFileRef.current?.click()}
                    className="vault-sheet-inline-btn"
                  >
                    <Upload size={13} />
                    导入
                  </Button>
                </div>
              </div>
              <Textarea
                value={form.private_key ?? ''}
                onChange={(event) => updateField('private_key', event.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                required
                rows={6}
                className={`pf-input-mono pf-key-textarea vault-form-key-textarea ${showPrivateKey ? '' : 'vault-form-key-hidden'}`}
              />
              <input
                ref={privateKeyFileRef}
                type="file"
                accept=".pem,.key,.id_rsa,.id_ed25519"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) readFile(file, 'private_key')
                  event.target.value = ''
                }}
              />
            </section>

            <section className="vault-form-key-panel vault-form-key-panel-pub">
              <div className="vault-form-key-head">
                <span className="vault-form-key-title">公钥（可选）</span>
                <div className="vault-form-key-actions">
                  <div ref={copyMenuRef} className="vault-key-copy">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setCopyMenuOpen((current) => !current)}
                      disabled={!form.public_key?.trim()}
                      className="vault-sheet-inline-btn"
                      aria-haspopup="menu"
                      aria-expanded={copyMenuOpen}
                    >
                      <Copy size={13} />
                      复制
                      <ChevronDown size={12} />
                    </Button>
                    {copyMenuOpen ? (
                      <div className="vault-key-copy-menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => void handleCopyPublicKey('content')}>
                          <FileText size={14} />
                          <span>
                            <strong>复制公钥内容</strong>
                            <small>复制完整的 OpenSSH 公钥</small>
                          </span>
                        </button>
                        <button type="button" role="menuitem" onClick={() => void handleCopyPublicKey('command')}>
                          <Terminal size={14} />
                          <span>
                            <strong>复制公钥导入指令</strong>
                            <small>追加到 authorized_keys</small>
                          </span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => publicKeyFileRef.current?.click()}
                    className="vault-sheet-inline-btn"
                  >
                    <Upload size={13} />
                    导入
                  </Button>
                </div>
              </div>
              <Textarea
                value={form.public_key ?? ''}
                onChange={(event) => updateField('public_key', event.target.value)}
                placeholder="ssh-ed25519 AAAA..."
                rows={3}
                className="pf-input-mono pf-key-textarea vault-form-key-textarea vault-form-key-textarea-short"
              />
              <input
                ref={publicKeyFileRef}
                type="file"
                accept=".pub,.txt"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) readFile(file, 'public_key')
                  event.target.value = ''
                }}
              />
            </section>

            <div className="vault-form-passphrase-row">
              <div className="pf-field vault-form-passphrase-field">
                <Label className="pf-label">Passphrase（可选）</Label>
                <Input
                  type="password"
                  value={form.passphrase ?? ''}
                  onChange={(event) => updateField('passphrase', event.target.value)}
                  placeholder="请输入密码短语..."
                  className="pf-input-mono"
                />
              </div>
            </div>
          </>
        )}
      </div>

      <div className="vault-sheet-footer">
        {error ? <div className="pf-error vault-sheet-error">{error}</div> : <div />}
        <div className="vault-sheet-footer-actions">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="pf-btn-cancel">
            取消
          </Button>
          <Button type="submit" form="vault-form" disabled={!canSubmit} className="pf-btn-submit">
            {loading ? '保存中...' : isEditing ? '保存' : '创建'}
          </Button>
        </div>
      </div>
    </form>
  )
}
