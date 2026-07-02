import { useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
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
  { value: 'ed25519', label: 'ED25519 (推荐)' },
  { value: 'rsa-2048', label: 'RSA 2048' },
  { value: 'rsa-4096', label: 'RSA 4096' },
]

export function VaultGenerateDialog({ open, onOpenChange }: VaultGenerateDialogProps) {
  const { create } = useVaultStore()
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [comment, setComment] = useState('')
  const [certificate, setCertificate] = useState('')
  const [algo, setAlgo] = useState('ed25519')
  const [passphrase, setPassphrase] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<GenerateKeyResponse | null>(null)
  const [copiedField, setCopiedField] = useState<'public' | 'private' | 'command' | ''>('')

  const publicKeyLine = useMemo(() => {
    if (!result?.public_key) return ''
    const suffix = comment.trim()
    return suffix ? `${result.public_key} ${suffix}` : result.public_key
  }, [comment, result?.public_key])

  const importCommand = useMemo(() => {
    if (!publicKeyLine) return ''
    return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${publicKeyLine.replace(/'/g, `'\"'\"'`)}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
  }, [publicKeyLine])

  const handleGenerate = async () => {
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
      if (!name.trim()) {
        const algoTag = algo === 'ed25519' ? 'ed25519' : algo.endsWith('4096') ? 'rsa4096' : 'rsa2048'
        setName(`generated-${algoTag}`)
      }
      notify.success('SSH 密钥对已生成')
    } catch (err) {
      const message = (err as { error?: { message?: string } })?.error?.message ?? (err as Error).message
      notify.error(message || '生成失败')
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = async (text: string, field: 'public' | 'private' | 'command') => {
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
    if (!name.trim()) {
      notify.warning('请先填写名称')
      return
    }
    setSaving(true)
    try {
      await create({
        name: name.trim(),
        username: username.trim() || undefined,
        type: certificate.trim() ? 'ssh_certificate' : 'private_key',
        private_key: result.private_key,
        passphrase: passphrase || undefined,
        certificate: certificate.trim() || undefined,
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

  const handleClose = (openState: boolean) => {
    if (!openState) {
      setResult(null)
      setCertificate('')
      setPassphrase('')
      setCopiedField('')
      setComment('')
      setName('')
      setUsername('')
      setAlgo('ed25519')
    }
    onOpenChange(openState)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent onClose={() => handleClose(false)} className="vault-gen-dialog-content">
        <DialogHeader className="vault-gen-header">
          <DialogTitle>生成 SSH 密钥对</DialogTitle>
        </DialogHeader>

        <div className="vault-gen-section">
          <div className="vault-gen-section-title">生成参数</div>
          <div className="vault-gen-grid">
            <div className="pf-field">
              <Label className="pf-label">算法</Label>
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
          </div>

          <Button type="button" onClick={handleGenerate} disabled={loading} className="pf-btn-submit vault-gen-primary">
            {loading ? '生成中...' : result ? '重新生成' : '生成密钥对'}
          </Button>
        </div>

        {result && (
          <div className="vault-gen-result">
            <div className="vault-gen-section">
              <div className="vault-gen-section-title">保存选项</div>
              <div className="vault-gen-grid">
                <div className="pf-field">
                  <Label className="pf-label">名称</Label>
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="例如：生产 SSH 密钥"
                  />
                </div>
                <div className="pf-field">
                  <Label className="pf-label">用户名（可选）</Label>
                  <Input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="例如：root"
                    className="pf-input-mono"
                  />
                </div>
              </div>

              <div className="vault-gen-grid">
                <div className="pf-field">
                  <Label className="pf-label">公钥注释（可选）</Label>
                  <Input
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    placeholder="例如：test@netcatty"
                    className="pf-input-mono"
                  />
                </div>
              </div>

              <div className="pf-field">
                <Label className="pf-label">SSH 证书（可选）</Label>
                <Textarea
                  value={certificate}
                  onChange={(event) => setCertificate(event.target.value)}
                  placeholder="可粘贴 OpenSSH certificate 内容；填写后将保存为 SSH 证书类型"
                  rows={4}
                  className="pf-input-mono pf-key-textarea"
                />
              </div>
            </div>

            <div className="vault-gen-section">
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
                <Textarea value={publicKeyLine} readOnly rows={2} className="pf-input-mono pf-key-textarea" />
              </div>

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
                <Textarea value={result.private_key} readOnly rows={7} className="pf-input-mono pf-key-textarea" />
              </div>
            </div>

            <div className="vault-gen-section">
              <div className="vault-gen-result-field">
                <div className="vault-gen-result-label">
                  <span>快速导入公钥</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => handleCopy(importCommand, 'command')}
                    title="复制导入指令"
                    aria-label="复制导入指令"
                    className="vault-act"
                  >
                    {copiedField === 'command' ? <Check size={13} /> : <Copy size={13} />}
                  </Button>
                </div>
                <Textarea value={importCommand} readOnly rows={3} className="pf-input-mono pf-key-textarea" />
                <div className="pf-help-text">将这段命令粘贴到目标服务器执行，可快速把公钥追加到 `authorized_keys`。</div>
              </div>
            </div>

            <Button type="button" onClick={handleSave} disabled={saving} className="pf-btn-submit vault-gen-primary">
              {saving ? '保存中...' : '保存到 Vault'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
