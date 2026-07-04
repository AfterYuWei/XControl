import { useEffect, useRef, useState, type RefObject } from 'react'
import { Dices, Upload } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { vaultApi } from '@/api/vault'
import { cn } from '@/lib/utils'
import { notify } from '@/store/notify'
import { useVaultStore } from '@/store/vault'
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

interface UploadTextareaFieldProps {
  label: string
  value: string
  placeholder: string
  required?: boolean
  rows?: number
  accept: string
  inputRef: RefObject<HTMLInputElement | null>
  outputClassName?: string
  onChange: (value: string) => void
  onPickFile: (file: File) => void
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
  certificate: '',
}

function buildInitialForm(item?: VaultItem | null): VaultCreateRequest {
  if (!item) return { ...EMPTY_FORM }

  return {
    name: item.name,
    type: item.type,
    username: item.username,
    remark: item.remark,
    password: '',
    private_key: '',
    public_key: '',
    passphrase: '',
    certificate: '',
  }
}

function UploadTextareaField({
  label,
  value,
  placeholder,
  required,
  rows = 4,
  accept,
  inputRef,
  outputClassName,
  onChange,
  onPickFile,
}: UploadTextareaFieldProps) {
  return (
    <section className="vault-sheet-panel vault-sheet-panel-span-2">
      <div className="vault-sheet-panel-head">
        <span className="vault-sheet-panel-title">{label}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} className="vault-sheet-inline-btn">
          <Upload size={13} />
          导入
        </Button>
      </div>

      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        required={required}
        className={cn('pf-input-mono pf-key-textarea vault-sheet-output', outputClassName)}
      />

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onPickFile(file)
          event.target.value = ''
        }}
      />
    </section>
  )
}

function RailSummary({
  vaultType,
  isEditing,
  username,
  remark,
}: {
  vaultType: VaultType
  isEditing: boolean
  username: string
  remark: string
}) {
  const isPassword = vaultType === 'password'
  const context = username.trim() || remark.trim()
    ? `${username.trim() || '未填用户名'}${remark.trim() ? ` / ${remark.trim()}` : ''}`
    : '建议补充上下文'

  return (
    <div className="vault-form-rail-summary">
      <div className="vault-form-rail-summary-item">
        <span className="vault-form-rail-summary-label">{isPassword ? '填写重点' : '保存规则'}</span>
        <span className="vault-form-rail-summary-value">
          {isPassword ? '密码建议搭配用户名或备注一起保存。' : isEditing ? '类型固定，内容可更新。' : '创建后类型不可修改。'}
        </span>
      </div>
      <div className="vault-form-rail-summary-item">
        <span className="vault-form-rail-summary-label">{isPassword ? '当前上下文' : '填写提示'}</span>
        <span className="vault-form-rail-summary-value">
          {isPassword ? context : '长内容建议通过导入或粘贴填写。'}
        </span>
      </div>
    </div>
  )
}

function PasswordEditorSection({
  password,
  username,
  remark,
  isEditing,
  showGenerator,
  onPasswordChange,
  onToggleGenerator,
  onApplyGeneratedPassword,
}: {
  password: string
  username: string
  remark: string
  isEditing: boolean
  showGenerator: boolean
  onPasswordChange: (value: string) => void
  onToggleGenerator: () => void
  onApplyGeneratedPassword: (password: string) => void
}) {
  const context = username.trim() || remark.trim()
    ? `${username.trim() || '未填用户名'}${remark.trim() ? ` / ${remark.trim()}` : ''}`
    : '建议填写用户名或备注'

  return (
    <section className="vault-sheet-panel vault-sheet-panel-span-2 vault-form-password-primary">
      <div className="vault-sheet-panel-head">
        <div className="vault-form-password-head">
          <span className="vault-sheet-panel-title">密码</span>
          <span className="vault-form-password-subtitle">手动输入或生成一条强密码，保存前尽量补齐上下文。</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onToggleGenerator}
          className="vault-sheet-inline-btn"
        >
          <Dices size={13} />
          {showGenerator ? '收起生成器' : '生成'}
        </Button>
      </div>

      <div className="vault-form-password-input-wrap">
        <Input
          type="password"
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
          placeholder="输入密码"
          required
          className="pf-input-mono vault-form-password-input"
        />
      </div>

      <div className="vault-form-password-summary">
        <div className="vault-form-password-summary-item">
          <span className="vault-form-password-summary-label">当前上下文</span>
          <span className="vault-form-password-summary-value">{context}</span>
        </div>
        <div className="vault-form-password-summary-item">
          <span className="vault-form-password-summary-label">推荐长度</span>
          <span className="vault-form-password-summary-value">16 到 24 位</span>
        </div>
        <div className="vault-form-password-summary-item">
          <span className="vault-form-password-summary-label">保存规则</span>
          <span className="vault-form-password-summary-value">{isEditing ? '类型固定，内容可更新' : '创建后类型不可修改'}</span>
        </div>
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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showGenerator, setShowGenerator] = useState(false)
  const publicKeyFileRef = useRef<HTMLInputElement>(null)
  const certFileRef = useRef<HTMLInputElement>(null)
  const privateKeyFileRef = useRef<HTMLInputElement>(null)
  const typeLabel = VAULT_TYPE_LABELS[form.type]

  useEffect(() => {
    if (!item) return

    vaultApi
      .reveal(item.id)
      .then((credential) => {
        setForm((current) => ({
          ...current,
          password: credential.password ?? '',
          private_key: credential.private_key ?? '',
          public_key: credential.public_key ?? '',
          passphrase: credential.passphrase ?? '',
          certificate: credential.certificate ?? '',
        }))
      })
      .catch(() => notify.warning('加载凭据内容失败，请重新输入'))
  }, [item])

  const readFile = (file: File, field: 'private_key' | 'public_key' | 'certificate') => {
    if (file.size > 100 * 1024) {
      notify.warning('文件过大，请控制在 100KB 以内')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      setForm((current) => ({ ...current, [field]: String(reader.result ?? '') }))
      notify.success('文件已导入')
    }
    reader.onerror = () => notify.error('读取文件失败')
    reader.readAsText(file)
  }

  const updateField = <K extends keyof VaultCreateRequest>(key: K, value: VaultCreateRequest[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()

    if (!form.name?.trim()) {
      setError('名称不能为空')
      return
    }

    setLoading(true)
    setError('')

    try {
      if (isEditing && item) {
        await update(item.id, form)
      } else {
        await create(form)
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
      <div className="vault-sheet-body vault-form-layout">
        <aside className="vault-sheet-rail">
          <section className="vault-sheet-panel vault-sheet-panel-hero vault-form-rail-panel">
            <div className="vault-sheet-chip-row">
              <span className="vault-sheet-chip">{typeLabel}</span>
            </div>

            <div className="vault-sheet-field-stack">
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
                {isEditing ? <div className="pf-help-text">编辑已有凭据时不允许修改类型。</div> : null}
              </div>

              <div className="pf-field">
                <Label className="pf-label">用户名</Label>
                <Input
                  value={form.username ?? ''}
                  onChange={(event) => updateField('username', event.target.value)}
                  placeholder="root"
                  className="pf-input-mono"
                />
              </div>

              <div className="pf-field">
                <Label className="pf-label">备注</Label>
                <Input
                  value={form.remark ?? ''}
                  onChange={(event) => updateField('remark', event.target.value)}
                  placeholder="可选"
                />
              </div>
            </div>

            <RailSummary
              vaultType={form.type}
              isEditing={isEditing}
              username={form.username ?? ''}
              remark={form.remark ?? ''}
            />
          </section>
        </aside>

        <div className="vault-sheet-main vault-sheet-grid vault-form-main">
          {form.type === 'password' ? (
            <PasswordEditorSection
              password={form.password ?? ''}
              username={form.username ?? ''}
              remark={form.remark ?? ''}
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
              <section className="vault-sheet-panel">
                <div className="vault-sheet-panel-head">
                  <span className="vault-sheet-panel-title">公钥</span>
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

                <Textarea
                  value={form.public_key ?? ''}
                  onChange={(event) => updateField('public_key', event.target.value)}
                  placeholder="ssh-ed25519 AAAA..."
                  rows={3}
                  className="pf-input-mono pf-key-textarea vault-sheet-output vault-sheet-output-medium"
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

              <section className="vault-sheet-panel">
                <div className="vault-sheet-panel-head">
                  <span className="vault-sheet-panel-title">Passphrase</span>
                </div>

                <Input
                  type="password"
                  value={form.passphrase ?? ''}
                  onChange={(event) => updateField('passphrase', event.target.value)}
                  placeholder="可留空"
                  className="pf-input-mono"
                />
              </section>

              <UploadTextareaField
                label={form.type === 'ssh_certificate' ? '配套私钥' : '私钥'}
                value={form.private_key ?? ''}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                required
                rows={6}
                accept=".pem,.key,.id_rsa,.id_ed25519"
                inputRef={privateKeyFileRef}
                outputClassName="vault-sheet-output-large"
                onChange={(value) => updateField('private_key', value)}
                onPickFile={(file) => readFile(file, 'private_key')}
              />

              {form.type === 'ssh_certificate' ? (
                <UploadTextareaField
                  label="证书"
                  value={form.certificate ?? ''}
                  placeholder="ssh-ed25519-cert-v01@openssh.com AAAA..."
                  required
                  rows={3}
                  accept=".cer,.crt,.pub,.cert"
                  inputRef={certFileRef}
                  outputClassName="vault-sheet-output-medium"
                  onChange={(value) => updateField('certificate', value)}
                  onPickFile={(file) => readFile(file, 'certificate')}
                />
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="vault-sheet-footer">
        {error ? <div className="pf-error vault-sheet-error">{error}</div> : <div />}
        <div className="vault-sheet-footer-actions">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="pf-btn-cancel">
            取消
          </Button>
          <Button type="submit" form="vault-form" disabled={loading} className="pf-btn-submit">
            {loading ? '保存中...' : isEditing ? '保存' : '创建'}
          </Button>
        </div>
      </div>
    </form>
  )
}
