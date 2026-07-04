import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Eye, EyeOff, Pencil } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { vaultApi } from '@/api/vault'
import { cn } from '@/lib/utils'
import { notify } from '@/store/notify'
import { VAULT_TYPE_LABELS, type VaultCredential, type VaultItem } from '@/types/vault'

interface VaultDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: VaultItem | null
  onEdit: (item: VaultItem) => void
}

type CopyField = 'password' | 'public' | 'private' | 'cert' | 'passphrase' | 'command' | ''
type SecretField = Exclude<CopyField, ''>

interface DetailPanelProps {
  title: string
  value: string
  field: SecretField
  copiedField: CopyField
  rows?: number
  panelClassName?: string
  outputClassName?: string
  onCopy: (text: string, field: SecretField) => void
}

interface DetailSecretFieldProps {
  title: string
  value: string
  field: SecretField
  copiedField: CopyField
  panelClassName?: string
  hint?: string
  onCopy: (text: string, field: SecretField) => void
}

function DetailPanel({
  title,
  value,
  field,
  copiedField,
  rows = 4,
  panelClassName,
  outputClassName,
  onCopy,
}: DetailPanelProps) {
  return (
    <section className={cn('vault-sheet-panel', panelClassName)}>
      <div className="vault-sheet-panel-head">
        <span className="vault-sheet-panel-title">{title}</span>
        <button
          type="button"
          className="vault-act"
          onClick={() => onCopy(value, field)}
          title={`复制${title}`}
          aria-label={`复制${title}`}
        >
          {copiedField === field ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <Textarea
        value={value}
        readOnly
        rows={rows}
        className={cn('pf-input-mono pf-key-textarea vault-sheet-output', outputClassName)}
      />
    </section>
  )
}

function DetailSecretField({
  title,
  value,
  field,
  copiedField,
  panelClassName,
  hint,
  onCopy,
}: DetailSecretFieldProps) {
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    setRevealed(false)
  }, [value])

  return (
    <section className={cn('vault-sheet-panel', panelClassName)}>
      <div className="vault-sheet-panel-head">
        <span className="vault-sheet-panel-title">{title}</span>
        <div className="vault-detail-secret-actions">
          <button
            type="button"
            className="vault-act"
            onClick={() => setRevealed((current) => !current)}
            title={revealed ? `隐藏${title}` : `显示${title}`}
            aria-label={revealed ? `隐藏${title}` : `显示${title}`}
          >
            {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button
            type="button"
            className="vault-act"
            onClick={() => onCopy(value, field)}
            title={`复制${title}`}
            aria-label={`复制${title}`}
          >
            {copiedField === field ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      </div>

      <Input
        type={revealed ? 'text' : 'password'}
        value={value}
        readOnly
        className="pf-input-mono vault-detail-secret-input"
      />

      {hint ? <div className="pf-help-text vault-detail-secret-hint">{hint}</div> : null}
    </section>
  )
}

function DetailAccentPanel({
  typeLabel,
  fingerprint,
  hasPassphrase,
}: {
  typeLabel: string
  fingerprint: string
  hasPassphrase: boolean
}) {
  return (
    <section className="vault-sheet-panel vault-detail-accent-panel">
      <div className="vault-detail-accent-kicker">Vault</div>
      <div className="vault-detail-accent-title">凭据内容已解密到当前查看面板</div>
      <div className="vault-detail-accent-desc">
        敏感内容仅在当前窗口解密展示，可按需复制单项内容。
      </div>

      <div className="vault-detail-accent-stats">
        <div className="vault-detail-accent-stat">
          <span className="vault-detail-accent-stat-label">类型</span>
          <span className="vault-detail-accent-stat-value">{typeLabel}</span>
        </div>
        <div className="vault-detail-accent-stat">
          <span className="vault-detail-accent-stat-label">指纹</span>
          <span className="vault-detail-accent-stat-value vault-detail-accent-stat-value-mono">{fingerprint}</span>
        </div>
        <div className="vault-detail-accent-stat">
          <span className="vault-detail-accent-stat-label">附加保护</span>
          <span className="vault-detail-accent-stat-value">{hasPassphrase ? '已设置 Passphrase' : '未设置 Passphrase'}</span>
        </div>
      </div>
    </section>
  )
}

export function VaultDetailDialog({ open, onOpenChange, item, onEdit }: VaultDetailDialogProps) {
  const [credential, setCredential] = useState<VaultCredential | null>(null)
  const [loadedItemId, setLoadedItemId] = useState('')
  const [loadError, setLoadError] = useState('')
  const [copiedField, setCopiedField] = useState<CopyField>('')

  const loading = open && !!item && loadedItemId !== item.id

  useEffect(() => {
    if (!open || !item) return

    vaultApi
      .reveal(item.id)
      .then((data) => {
        setCredential(data)
        setLoadedItemId(item.id)
        setLoadError('')
      })
      .catch(() => {
        notify.error('加载凭据内容失败')
        setCredential(null)
        setLoadedItemId(item.id)
        setLoadError('加载凭据内容失败')
      })
  }, [open, item])

  const publicKeyValue = credential?.public_key?.trim() || ''
  const typeLabel = item ? VAULT_TYPE_LABELS[item.type] : ''
  const username = item?.username?.trim() || '未填写'
  const fingerprint = item?.fingerprint?.trim() || '未生成'
  const remark = item?.remark?.trim()

  const importCommand = useMemo(() => {
    if (!publicKeyValue) return ''
    return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${publicKeyValue.replace(/'/g, `'"'"'`)}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
  }, [publicKeyValue])

  const handleCopy = async (text: string, field: SecretField) => {
    if (!text) {
      notify.warning('没有可复制的内容')
      return
    }

    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(field)
      notify.success('已复制')
      setTimeout(() => setCopiedField(''), 1500)
    } catch {
      notify.error('复制失败')
    }
  }

  const handleEdit = () => {
    if (!item) return
    onOpenChange(false)
    onEdit(item)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={() => onOpenChange(false)} className="vault-sheet-dialog-content vault-detail-dialog-content">
        <DialogHeader className="vault-sheet-header">
          <div className="vault-sheet-header-top">
            <div className="vault-sheet-title-wrap">
              <span className="vault-sheet-eyebrow">Vault</span>
              <DialogTitle>{item?.name || '查看凭据'}</DialogTitle>
            </div>
            {item ? (
              <Button type="button" variant="outline" size="sm" onClick={handleEdit} className="vault-sheet-header-btn">
                <Pencil size={14} />
                编辑
              </Button>
            ) : null}
          </div>
        </DialogHeader>

        {loading ? (
          <div className="vault-loading">
            <div className="vault-spinner" />
            <div className="vault-empty-desc">加载中...</div>
          </div>
        ) : item && credential ? (
          <div className="vault-sheet-body vault-detail-body-shell">
            <aside className="vault-sheet-rail vault-detail-rail">
              <section className="vault-sheet-panel vault-sheet-panel-hero vault-detail-hero-panel">
                <div className="vault-detail-hero-orb" aria-hidden="true" />

                <div className="vault-sheet-chip-row">
                  <span className="vault-sheet-chip">{typeLabel}</span>
                  {item.has_passphrase ? <span className="vault-sheet-chip vault-sheet-chip-alert">Passphrase</span> : null}
                </div>

                <div className="vault-sheet-meta-list">
                  <div className="vault-sheet-meta-item">
                    <span className="vault-sheet-meta-label">用户名</span>
                    <span className="vault-sheet-meta-value vault-sheet-meta-value-mono">{username}</span>
                  </div>
                  <div className="vault-sheet-meta-item">
                    <span className="vault-sheet-meta-label">指纹</span>
                    <span className="vault-sheet-meta-value vault-sheet-meta-value-mono">{fingerprint}</span>
                  </div>
                  {remark ? (
                    <div className="vault-sheet-meta-item">
                      <span className="vault-sheet-meta-label">备注</span>
                      <span className="vault-sheet-meta-value">{remark}</span>
                    </div>
                  ) : null}
                </div>
              </section>

              <DetailAccentPanel typeLabel={typeLabel} fingerprint={fingerprint} hasPassphrase={item.has_passphrase} />
            </aside>

            <div className="vault-sheet-main vault-sheet-grid vault-detail-main">
              {item.type === 'password' && credential.password ? (
                <DetailSecretField
                  title="密码"
                  value={credential.password}
                  field="password"
                  copiedField={copiedField}
                  panelClassName="vault-sheet-panel-span-2"
                  hint="单行密码栏便于快速查看与复制。"
                  onCopy={handleCopy}
                />
              ) : null}

              {(item.type === 'private_key' || item.type === 'ssh_certificate') && publicKeyValue ? (
                <DetailPanel
                  title="公钥"
                  value={publicKeyValue}
                  field="public"
                  copiedField={copiedField}
                  rows={4}
                  panelClassName="vault-sheet-panel-span-2"
                  outputClassName="vault-sheet-output-medium"
                  onCopy={handleCopy}
                />
              ) : null}

              {credential.passphrase ? (
                <DetailSecretField
                  title="Passphrase"
                  value={credential.passphrase}
                  field="passphrase"
                  panelClassName={item.type === 'password' ? 'vault-sheet-panel-span-2' : undefined}
                  copiedField={copiedField}
                  onCopy={handleCopy}
                />
              ) : null}

              {credential.private_key ? (
                <DetailPanel
                  title="私钥"
                  value={credential.private_key}
                  field="private"
                  copiedField={copiedField}
                  rows={8}
                  panelClassName="vault-sheet-panel-span-2"
                  outputClassName="vault-sheet-output-large vault-detail-output-private"
                  onCopy={handleCopy}
                />
              ) : null}

              {credential.certificate ? (
                <DetailPanel
                  title="证书"
                  value={credential.certificate}
                  field="cert"
                  copiedField={copiedField}
                  rows={4}
                  panelClassName="vault-sheet-panel-span-2"
                  outputClassName="vault-sheet-output-medium"
                  onCopy={handleCopy}
                />
              ) : null}

              {importCommand ? (
                <DetailPanel
                  title="导入指令"
                  value={importCommand}
                  field="command"
                  copiedField={copiedField}
                  rows={4}
                  panelClassName="vault-sheet-panel-span-2"
                  outputClassName="vault-sheet-output-medium"
                  onCopy={handleCopy}
                />
              ) : null}

              {item.type === 'password' ? (
                <section className="vault-sheet-panel vault-sheet-panel-span-2 vault-detail-password-decor">
                  <div className="vault-detail-password-decor-line" />
                  <div className="vault-detail-password-decor-line vault-detail-password-decor-line-short" />
                  <div className="vault-detail-password-decor-copy">Vault 会在当前窗口内处理敏感信息，不会改变凭据原始类型与内容。</div>
                </section>
              ) : null}
            </div>
          </div>
        ) : loadError ? (
          <div className="vault-error">
            <div className="vault-error-title">{loadError}</div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
