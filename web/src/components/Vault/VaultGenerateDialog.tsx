import { useState } from 'react'
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
import { Copy, Check } from 'lucide-react'
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
  const [algo, setAlgo] = useState('ed25519')
  const [passphrase, setPassphrase] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<GenerateKeyResponse | null>(null)
  const [copiedField, setCopiedField] = useState<'public' | 'private' | ''>('')

  const handleGenerate = async () => {
    setLoading(true)
    setResult(null)
    try {
      const reqAlgo = algo.startsWith('rsa') ? 'rsa' : 'ed25519'
      const bits = algo === 'rsa-2048' ? 2048 : algo === 'rsa-4096' ? 4096 : undefined
      const res = await vaultApi.generateKeyPair({
        algo: reqAlgo as 'rsa' | 'ed25519',
        bits,
        passphrase: passphrase || undefined,
      })
      setResult(res)
      notify.success('密钥对已生成')
    } catch (err) {
      const msg = (err as { error?: { message?: string } })?.error?.message ?? (err as Error).message
      notify.error(msg || '生成失败')
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
    setSaving(true)
    try {
      const algoTag = algo === 'ed25519' ? 'ed25519' : `rsa${algo.endsWith('4096') ? '4096' : '2048'}`
      await create({
        name: `generated-${algoTag}-${Date.now().toString(36)}`,
        type: 'private_key',
        private_key: result.private_key,
        passphrase: passphrase || undefined,
      })
      onOpenChange(false)
      // 重置
      setResult(null)
      setPassphrase('')
    } catch (err) {
      const msg = (err as { error?: { message?: string } })?.error?.message ?? (err as Error).message
      notify.error(msg || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleClose = (v: boolean) => {
    if (!v) {
      setResult(null)
      setPassphrase('')
    }
    onOpenChange(v)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent onClose={() => handleClose(false)} className="vault-gen-dialog-content">
        <DialogHeader className="mb-4">
          <DialogTitle>生成 SSH 密钥对</DialogTitle>
        </DialogHeader>

        <div className="pf-field">
          <Label className="pf-label">算法</Label>
          <Select
            options={ALGO_OPTIONS}
            value={algo}
            onChange={(v) => setAlgo(v)}
          />
        </div>

        <div className="pf-field">
          <Label className="pf-label">Passphrase(可选)</Label>
          <Input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="留空表示无 passphrase"
            className="pf-input-mono"
          />
        </div>

        <Button
          type="button"
          onClick={handleGenerate}
          disabled={loading}
          className="pf-btn-submit"
        >
          {loading ? '生成中…' : result ? '重新生成' : '生成密钥对'}
        </Button>

        {result && (
          <div className="vault-gen-result">
            <div className="vault-gen-result-field">
              <div className="vault-gen-result-label">
                <span>公钥</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleCopy(result.public_key, 'public')}
                  title="复制公钥"
                  aria-label="复制公钥"
                  className="vault-act"
                >
                  {copiedField === 'public' ? <Check size={13} /> : <Copy size={13} />}
                </Button>
              </div>
              <Textarea
                value={result.public_key}
                readOnly
                rows={2}
                className="pf-input-mono pf-key-textarea"
              />
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
              <Textarea
                value={result.private_key}
                readOnly
                rows={6}
                className="pf-input-mono pf-key-textarea"
              />
            </div>

            <div className="vault-gen-result-fp">指纹: {result.fingerprint}</div>

            <Button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="pf-btn-submit"
            >
              {saving ? '保存中…' : '保存到保险箱'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
