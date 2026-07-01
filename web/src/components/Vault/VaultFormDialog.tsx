import { useState, useEffect, useRef } from 'react'
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
import { Upload, Dices } from 'lucide-react'
import { useVaultStore } from '@/store/vault'
import { vaultApi } from '@/api/vault'
import { notify } from '@/store/notify'
import { VAULT_TYPE_LABELS, type VaultItem, type VaultType, type VaultCreateRequest } from '@/types/vault'
import { VaultPasswordGenerator } from './VaultPasswordGenerator'

interface VaultFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When set, edit mode; otherwise create mode. */
  item?: VaultItem | null
}

const TYPE_OPTIONS = (Object.keys(VAULT_TYPE_LABELS) as VaultType[]).map((t) => ({
  value: t,
  label: VAULT_TYPE_LABELS[t],
}))

export function VaultFormDialog({ open, onOpenChange, item }: VaultFormDialogProps) {
  const { create, update } = useVaultStore()
  const isEditing = !!item

  const [form, setForm] = useState<VaultCreateRequest>({
    name: '',
    type: 'password',
    username: '',
    remark: '',
    password: '',
    private_key: '',
    passphrase: '',
    certificate: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showGenerator, setShowGenerator] = useState(false)
  const certFileRef = useRef<HTMLInputElement>(null)
  const keyFileRef = useRef<HTMLInputElement>(null)

  // Reset form on open; for edit, fetch revealed credential to pre-fill
  useEffect(() => {
    if (!open) return
    setError('')
    setShowGenerator(false)
    if (item) {
      setForm({
        name: item.name,
        type: item.type,
        username: item.username,
        remark: item.remark,
        password: '',
        private_key: '',
        passphrase: '',
        certificate: '',
      })
      vaultApi
        .reveal(item.id)
        .then((cred) => {
          setForm((f) => ({
            ...f,
            password: cred.password ?? '',
            private_key: cred.private_key ?? '',
            passphrase: cred.passphrase ?? '',
            certificate: cred.certificate ?? '',
          }))
        })
        .catch(() => notify.warning('加载凭据内容失败,请重新输入'))
    } else {
      setForm({
        name: '',
        type: 'password',
        remark: '',
        password: '',
        private_key: '',
        passphrase: '',
        certificate: '',
      })
    }
  }, [open, item])

  const readFile = (file: File, field: 'private_key' | 'certificate') => {
    if (file.size > 100 * 1024) {
      notify.warning('文件过大,请限制在 100KB 以内')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setForm((f) => ({ ...f, [field]: String(reader.result ?? '') }))
      notify.success('文件已读取')
    }
    reader.onerror = () => notify.error('读取文件失败')
    reader.readAsText(file)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) {
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
      const msg = (err as { error?: { message?: string } })?.error?.message ?? (err as Error).message
      setError(msg || '操作失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)} className="max-w-lg">
        <DialogHeader className="mb-4">
          <DialogTitle>{isEditing ? '编辑凭据' : '新建凭据'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} id="vault-form" className="vault-form">
          {/* 名称 */}
          <div className="pf-field">
            <Label className="pf-label">名称</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="prod-root-key"
              required
              className="pf-input-mono"
            />
          </div>

          {/* 类型 */}
          <div className="pf-field">
            <Label className="pf-label">类型</Label>
            <Select
              options={TYPE_OPTIONS}
              value={form.type}
              onChange={(v) => setForm({ ...form, type: v as VaultType })}
            />
          </div>

          {/* 用户名 */}
          <div className="pf-field">
            <Label className="pf-label">用户名</Label>
            <Input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="root (可选，用于自动填充 Profile)"
              className="pf-input-mono"
            />
          </div>

          {/* 备注 */}
          <div className="pf-field">
            <Label className="pf-label">备注</Label>
            <Input
              value={form.remark}
              onChange={(e) => setForm({ ...form, remark: e.target.value })}
              placeholder="可选"
            />
          </div>

          {/* 类型相关字段 */}
          {form.type === 'password' && (
            <div className="pf-field">
              <Label className="pf-label">密码</Label>
              <div className="vault-input-with-action">
                <Input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="输入密码"
                  required
                  className="pf-input-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowGenerator((v) => !v)}
                  title="生成密码"
                  aria-label="生成密码"
                >
                  <Dices size={14} />
                </Button>
              </div>
              {showGenerator && (
                <VaultPasswordGenerator
                  onApply={(pwd) => {
                    setForm((f) => ({ ...f, password: pwd }))
                    setShowGenerator(false)
                  }}
                />
              )}
            </div>
          )}

          {form.type === 'private_key' && (
            <>
              <div className="pf-field">
                <Label className="pf-label">私钥</Label>
                <div className="vault-textarea-header">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => keyFileRef.current?.click()}
                  >
                    <Upload size={12} /> 从文件导入
                  </Button>
                  <input
                    ref={keyFileRef}
                    type="file"
                    accept=".pem,.key,.id_rsa,.id_ed25519"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) readFile(f, 'private_key')
                      e.target.value = ''
                    }}
                  />
                </div>
                <Textarea
                  value={form.private_key}
                  onChange={(e) => setForm({ ...form, private_key: e.target.value })}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  rows={5}
                  required
                  className="pf-input-mono pf-key-textarea"
                />
              </div>
              <div className="pf-field">
                <Label className="pf-label">Passphrase(可选)</Label>
                <Input
                  type="password"
                  value={form.passphrase}
                  onChange={(e) => setForm({ ...form, passphrase: e.target.value })}
                  placeholder="留空表示无 passphrase"
                  className="pf-input-mono"
                />
              </div>
            </>
          )}

          {form.type === 'ssh_certificate' && (
            <>
              <div className="pf-field">
                <Label className="pf-label">证书</Label>
                <div className="vault-textarea-header">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => certFileRef.current?.click()}
                  >
                    <Upload size={12} /> 从文件导入
                  </Button>
                  <input
                    ref={certFileRef}
                    type="file"
                    accept=".cer,.crt,.pub,.cert"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) readFile(f, 'certificate')
                      e.target.value = ''
                    }}
                  />
                </div>
                <Textarea
                  value={form.certificate}
                  onChange={(e) => setForm({ ...form, certificate: e.target.value })}
                  placeholder="ssh-ed25519-cert-v01@openssh.com AAAA..."
                  rows={3}
                  required
                  className="pf-input-mono pf-key-textarea"
                />
              </div>
              <div className="pf-field">
                <Label className="pf-label">配套私钥</Label>
                <div className="vault-textarea-header">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => keyFileRef.current?.click()}
                  >
                    <Upload size={12} /> 从文件导入
                  </Button>
                  <input
                    ref={keyFileRef}
                    type="file"
                    accept=".pem,.key,.id_rsa,.id_ed25519"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) readFile(f, 'private_key')
                      e.target.value = ''
                    }}
                  />
                </div>
                <Textarea
                  value={form.private_key}
                  onChange={(e) => setForm({ ...form, private_key: e.target.value })}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  rows={5}
                  required
                  className="pf-input-mono pf-key-textarea"
                />
              </div>
              <div className="pf-field">
                <Label className="pf-label">Passphrase(可选)</Label>
                <Input
                  type="password"
                  value={form.passphrase}
                  onChange={(e) => setForm({ ...form, passphrase: e.target.value })}
                  placeholder="留空表示无 passphrase"
                  className="pf-input-mono"
                />
              </div>
            </>
          )}

          {error && <div className="pf-error">{error}</div>}
        </form>

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
            form="vault-form"
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
