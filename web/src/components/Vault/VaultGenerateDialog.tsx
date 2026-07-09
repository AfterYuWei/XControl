import { useMemo, useState } from 'react'
import { ArrowLeft, Check, Copy } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { vaultApi } from '@/api/vault'
import { useVaultStore } from '@/store/vault'
import { notify } from '@/store/notify'
import type { GenerateKeyResponse } from '@/types/vault'

interface VaultGenerateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const ALGO_OPTIONS = [
  { value: 'ed25519', label: 'ED25519（推荐）' },
  { value: 'rsa-2048', label: 'RSA 2048' },
  { value: 'rsa-4096', label: 'RSA 4096' },
]

export function VaultGenerateDialog({ open, onOpenChange }: VaultGenerateDialogProps) {
  const { create } = useVaultStore()
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [comment, setComment] = useState('')
  const [algo, setAlgo] = useState('ed25519')
  const [passphrase, setPassphrase] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<GenerateKeyResponse | null>(null)
  const [copiedField, setCopiedField] = useState<'public' | 'private' | ''>('')

  const isResultStep = result !== null
  const canGenerate = name.trim().length > 0 && username.trim().length > 0 && !loading

  const publicKeyLine = useMemo(() => {
    if (!result?.public_key) return ''
    const suffix = comment.trim()
    return suffix ? `${result.public_key} ${suffix}` : result.public_key
  }, [comment, result?.public_key])

  const algoLabel = useMemo(() => {
    return ALGO_OPTIONS.find((option) => option.value === algo)?.label ?? algo.toUpperCase()
  }, [algo])

  const resetState = () => {
    setResult(null)
    setPassphrase('')
    setCopiedField('')
    setComment('')
    setName('')
    setUsername('')
    setAlgo('ed25519')
    setLoading(false)
    setSaving(false)
  }

  const validateRequiredFields = () => {
    if (name.trim() && username.trim()) return true
    notify.warning('请先填写名称和用户名')
    return false
  }

  const handleGenerate = async () => {
    if (!validateRequiredFields()) return

    setLoading(true)
    setResult(null)

    try {
      const reqAlgo = algo.startsWith('rsa') ? 'rsa' : 'ed25519'
      const bits = algo === 'rsa-2048' ? 2048 : algo === 'rsa-4096' ? 4096 : undefined
      const response = await vaultApi.generateKeyPair({
        algo: reqAlgo as 'rsa' | 'ed25519',
        bits,
        passphrase: passphrase || undefined,
      })
      setResult(response)
      notify.success('SSH 密钥对已生成')
    } catch (err) {
      const message = (err as { error?: { message?: string } })?.error?.message ?? (err as Error).message
      notify.error(message || '生成失败')
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = async (text: string, field: 'public' | 'private') => {
    if (!text) return

    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(field)
      notify.success('已复制')
      setTimeout(() => setCopiedField(''), 1500)
    } catch {
      notify.error('复制失败')
    }
  }

  const handleSave = async () => {
    if (!result) return
    if (!validateRequiredFields()) return

    setSaving(true)

    try {
      await create({
        name: name.trim(),
        username: username.trim(),
        type: 'private_key',
        private_key: result.private_key,
        public_key: publicKeyLine || undefined,
        passphrase: passphrase || undefined,
        remark: comment.trim() || undefined,
      })
      handleClose(false)
      notify.success('已保存到 Vault')
    } catch (err) {
      const message = (err as { error?: { message?: string } })?.error?.message ?? (err as Error).message
      notify.error(message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleBackToForm = () => {
    setResult(null)
    setCopiedField('')
  }

  const handleClose = (openState: boolean) => {
    if (!openState) resetState()
    onOpenChange(openState)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent onClose={() => handleClose(false)} className="vault-gen-dialog-content">
        <DialogHeader className="vault-gen-header">
          <div className="vault-gen-header-top">
            <DialogTitle>{isResultStep ? '保存 SSH 密钥' : '生成 SSH 密钥对'}</DialogTitle>
            {isResultStep ? (
              <Button type="button" variant="outline" size="sm" onClick={handleBackToForm} className="vault-gen-secondary">
                <ArrowLeft size={14} />
                返回修改
              </Button>
            ) : null}
          </div>
        </DialogHeader>

        <div className="vault-gen-body">
          {!isResultStep ? (
            <>
              <div className="vault-gen-shell">
                <div className="vault-gen-grid vault-gen-grid-compact">
                  <div className="pf-field">
                    <Label className="pf-label">名称</Label>
                    <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：生产 SSH 密钥" />
                  </div>

                  <div className="pf-field">
                    <Label className="pf-label">用户名</Label>
                    <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="例如：root" className="pf-input-mono" />
                  </div>

                  <div className="pf-field">
                    <Label className="pf-label">密钥算法</Label>
                    <Select options={ALGO_OPTIONS} value={algo} onChange={(value) => setAlgo(value)} />
                  </div>

                  <div className="pf-field">
                    <Label className="pf-label">Passphrase（可选）</Label>
                    <Input
                      type="password"
                      value={passphrase}
                      onChange={(event) => setPassphrase(event.target.value)}
                      placeholder="留空表示不加密私钥"
                      className="pf-input-mono"
                    />
                  </div>

                  <div className="pf-field vault-gen-field-span-2">
                    <Label className="pf-label">公钥注释（可选）</Label>
                    <Input
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder="例如：ops@netcatty"
                      className="pf-input-mono"
                    />
                  </div>
                </div>
              </div>

              <div className="vault-gen-footer vault-gen-footer-actions">
                <Button type="button" onClick={handleGenerate} disabled={!canGenerate} className="pf-btn-submit vault-gen-primary">
                  {loading ? '生成中...' : '生成密钥'}
                </Button>
              </div>
            </>
          ) : (
            <div className="vault-gen-result-shell">
              <div className="vault-gen-summary">
                <div className="vault-gen-summary-item">
                  <span className="vault-gen-summary-label">名称</span>
                  <span className="vault-gen-summary-value">{name.trim()}</span>
                </div>
                <div className="vault-gen-summary-item">
                  <span className="vault-gen-summary-label">登录用户</span>
                  <span className="vault-gen-summary-value vault-gen-summary-value-mono">{username.trim()}</span>
                </div>
                <div className="vault-gen-summary-item">
                  <span className="vault-gen-summary-label">算法</span>
                  <span className="vault-gen-summary-value">{algoLabel}</span>
                </div>
                <div className="vault-gen-summary-item vault-gen-summary-item-wide">
                  <span className="vault-gen-summary-label">指纹</span>
                  <span className="vault-gen-summary-value vault-gen-summary-value-mono">
                    {result.fingerprint || '生成完成后显示'}
                  </span>
                </div>
              </div>

              <div className="vault-gen-result-grid">
                <div className="vault-gen-result-panel">
                  <div className="vault-gen-result-field">
                    <div className="vault-gen-result-label">
                      <span>公钥</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => handleCopy(publicKeyLine, 'public')}
                        title="复制公钥"
                        aria-label="复制公钥"
                        className="vault-act"
                      >
                        {copiedField === 'public' ? <Check size={13} /> : <Copy size={13} />}
                      </Button>
                    </div>
                    <Textarea
                      value={publicKeyLine}
                      readOnly
                      rows={4}
                      className="pf-input-mono pf-key-textarea vault-gen-output vault-gen-output-public"
                    />
                  </div>
                </div>

                <div className="vault-gen-result-panel">
                  <div className="vault-gen-result-field">
                    <div className="vault-gen-result-label">
                      <span>私钥</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => handleCopy(result.private_key, 'private')}
                        title="复制私钥"
                        aria-label="复制私钥"
                        className="vault-act"
                      >
                        {copiedField === 'private' ? <Check size={13} /> : <Copy size={13} />}
                      </Button>
                    </div>
                    <Textarea
                      value={result.private_key}
                      readOnly
                      rows={7}
                      className="pf-input-mono pf-key-textarea vault-gen-output vault-gen-output-private"
                    />
                  </div>
                </div>
              </div>

              <div className="vault-gen-footer vault-gen-footer-result">
                <div className="vault-gen-actions">
                  <Button type="button" variant="outline" onClick={handleBackToForm} className="vault-gen-secondary">
                    返回修改
                  </Button>
                  <Button type="button" onClick={handleSave} disabled={saving} className="pf-btn-submit vault-gen-primary">
                    {saving ? '保存中...' : '保存到 Vault'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
