import { useState } from 'react'
import { Loader2, Plus, TestTube2, Trash2, ExternalLink, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toast'
import { syncApi } from '@/api/sync'
import type { ProviderConfig, ProviderType, SyncProviderMeta } from '@/types/sync'
import { PROVIDER_TYPE_LABELS } from '@/types/sync'

const typeOptions = (Object.keys(PROVIDER_TYPE_LABELS) as ProviderType[])
  .map((t) => ({ value: t, label: PROVIDER_TYPE_LABELS[t] }))

const isOAuth = (t: ProviderType) => t === 'gdrive' || t === 'onedrive'

interface Props {
  providers: SyncProviderMeta[]
  onChanged: () => void
}

const emptyForm = (type: ProviderType): ProviderConfig => ({
  type,
  name: '',
  enabled: true,
})

export function ProviderSection({ providers, onChanged }: Props) {
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<ProviderConfig>(emptyForm('webdav'))
  const [busy, setBusy] = useState(false)

  const patch = (k: keyof ProviderConfig, v: unknown) =>
    setForm((f) => ({ ...f, [k]: v }))

  const handleCreate = async () => {
    if (!form.name.trim()) {
      toast.warning('请填写名称')
      return
    }
    setBusy(true)
    try {
      await syncApi.createProvider(form)
      toast.success(`已添加「${form.name}」`)
      setAdding(false)
      setForm(emptyForm('webdav'))
      onChanged()
    } catch (err) {
      toast.error('添加失败', { description: errMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  const handleToggle = async (p: SyncProviderMeta) => {
    try {
      await syncApi.updateProvider(p.id, {
        type: p.type, name: p.name, enabled: !p.enabled,
      })
      onChanged()
    } catch (err) {
      toast.error('更新失败', { description: errMessage(err) })
    }
  }

  const handleAuthorize = async (p: SyncProviderMeta) => {
    try {
      const { url } = await syncApi.oauthURL(p.type as 'gdrive' | 'onedrive', p.id)
      window.open(url, '_blank', 'width=600,height=700')
      toast.info('请在打开的页面中完成授权，完成后回到此处刷新')
      // 授权完成后轮询刷新状态
      const timer = setInterval(() => void (async () => {
        try {
          const list = await syncApi.providers()
          const me = list.find((x) => x.id === p.id)
          if (me?.authorized) {
            clearInterval(timer)
            toast.success(`「${p.name}」授权成功`)
            onChanged()
          }
        } catch { /* ignore */ }
      })(), 3000)
      setTimeout(() => clearInterval(timer), 5 * 60 * 1000)
    } catch (err) {
      toast.error('获取授权链接失败', { description: errMessage(err) })
    }
  }

  const handleTest = async (p: SyncProviderMeta) => {
    setBusy(true)
    try {
      await syncApi.testProvider(p.id)
      toast.success(`「${p.name}」连接正常`)
    } catch (err) {
      toast.error(`「${p.name}」连接失败`, { description: errMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (p: SyncProviderMeta) => {
    if (!window.confirm(`删除云服务「${p.name}」？云端已有版本不会被删除。`)) return
    try {
      await syncApi.deleteProvider(p.id)
      toast.success('已删除')
      onChanged()
    } catch (err) {
      toast.error('删除失败', { description: errMessage(err) })
    }
  }

  return (
    <>
      {providers.length > 0 && (
        <div className="sync-provider-list">
          {providers.map((p) => (
            <div key={p.id} className="sync-provider-item">
              <div className="sync-provider-info">
                <span className="sync-provider-name">{p.name}</span>
                <span className="sync-provider-type">{PROVIDER_TYPE_LABELS[p.type]}</span>
                {isOAuth(p.type) && (
                  p.authorized ? (
                    <span className="sync-provider-auth ok"><ShieldCheck size={11} /> 已授权</span>
                  ) : (
                    <span className="sync-provider-auth">未授权</span>
                  )
                )}
              </div>
              <div className="sync-version-actions">
                {isOAuth(p.type) && !p.authorized && (
                  <Button variant="outline" size="sm" onClick={() => void handleAuthorize(p)}>
                    <ExternalLink size={12} /> 授权
                  </Button>
                )}
                <Switch checked={p.enabled} onCheckedChange={() => void handleToggle(p)} />
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void handleTest(p)} title="测试连接">
                  <TestTube2 size={13} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void handleDelete(p)} title="删除">
                  <Trash2 size={13} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!adding ? (
        <Button variant="outline" size="sm" onClick={() => setAdding(true)} className="backup-action">
          <Plus size={13} /> 添加云服务
        </Button>
      ) : (
        <div className="backup-card" style={{ marginTop: 8 }}>
          <div className="backup-row">
            <Label className="backup-row-label">类型</Label>
            <Select options={typeOptions} value={form.type}
              onChange={(v) => setForm(emptyForm(v as ProviderType))} className="settings-select" />
          </div>
          <div className="backup-row">
            <Label className="backup-row-label">名称</Label>
            <Input value={form.name} onChange={(e) => patch('name', e.target.value)} placeholder="例如：公司 NAS" />
          </div>

          {form.type === 'webdav' && (
            <>
              <div className="backup-row">
                <Label className="backup-row-label">地址</Label>
                <Input value={form.endpoint ?? ''} onChange={(e) => patch('endpoint', e.target.value)}
                  placeholder="https://dav.example.com/path/xcontrol" />
              </div>
              <div className="backup-row">
                <Label className="backup-row-label">用户名</Label>
                <Input value={form.username ?? ''} onChange={(e) => patch('username', e.target.value)} />
              </div>
              <div className="backup-row">
                <Label className="backup-row-label">密码</Label>
                <Input type="password" value={form.password ?? ''} onChange={(e) => patch('password', e.target.value)} />
              </div>
            </>
          )}

          {form.type === 's3' && (
            <>
              <div className="backup-row">
                <Label className="backup-row-label">Endpoint</Label>
                <Input value={form.s3_endpoint ?? ''} onChange={(e) => patch('s3_endpoint', e.target.value)}
                  placeholder="留空 = AWS；MinIO 填 http://host:9000" />
              </div>
              <div className="backup-row">
                <Label className="backup-row-label">Region</Label>
                <Input value={form.s3_region ?? ''} onChange={(e) => patch('s3_region', e.target.value)} placeholder="us-east-1" />
              </div>
              <div className="backup-row">
                <Label className="backup-row-label">Bucket</Label>
                <Input value={form.s3_bucket ?? ''} onChange={(e) => patch('s3_bucket', e.target.value)} />
              </div>
              <div className="backup-row">
                <Label className="backup-row-label">AccessKey</Label>
                <Input value={form.s3_access_key ?? ''} onChange={(e) => patch('s3_access_key', e.target.value)} />
              </div>
              <div className="backup-row">
                <Label className="backup-row-label">SecretKey</Label>
                <Input type="password" value={form.s3_secret_key ?? ''} onChange={(e) => patch('s3_secret_key', e.target.value)} />
              </div>
              <div className="backup-row">
                <Label className="backup-row-label">前缀</Label>
                <Input value={form.s3_prefix ?? ''} onChange={(e) => patch('s3_prefix', e.target.value)} placeholder="xcontrol/（可选）" />
              </div>
              <div className="backup-row">
                <Label className="backup-row-label">PathStyle</Label>
                <Switch checked={form.s3_path_style ?? false}
                  onCheckedChange={(v) => patch('s3_path_style', v)} />
                <span className="settings-field-desc">MinIO 等需开启</span>
              </div>
            </>
          )}

          {isOAuth(form.type) && (
            <>
              <div className="backup-warning" style={{ marginTop: 2 }}>
                <ShieldCheck size={13} />
                <span>
                  {form.type === 'gdrive'
                    ? '需在 Google Cloud Console 创建 OAuth 应用（类型：Web 应用），回调地址填：' + location.origin + '/api/sync/oauth/gdrive/callback'
                    : '需在 Azure Portal 注册应用，回调地址填：' + location.origin + '/api/sync/oauth/onedrive/callback'}
                </span>
              </div>
              <div className="backup-row">
                <Label className="backup-row-label">Client ID</Label>
                <Input value={form.oauth_client_id ?? ''} onChange={(e) => patch('oauth_client_id', e.target.value)} />
              </div>
              <div className="backup-row">
                <Label className="backup-row-label">Client Secret</Label>
                <Input type="password" value={form.oauth_client_secret ?? ''} onChange={(e) => patch('oauth_client_secret', e.target.value)} />
              </div>
              {form.type === 'onedrive' && (
                <div className="backup-row">
                  <Label className="backup-row-label">文件夹</Label>
                  <Input value={form.onedrive_folder ?? ''} onChange={(e) => patch('onedrive_folder', e.target.value)}
                    placeholder="xcontrol-backups（默认）" />
                </div>
              )}
              <div className="settings-field-desc">保存后点击列表中的「授权」按钮完成 OAuth 授权</div>
            </>
          )}

          <div className="backup-row">
            <Button size="sm" onClick={() => void handleCreate()} disabled={busy}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
              保存
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>取消</Button>
          </div>
          <div className="settings-field-desc">凭证（密码 / SecretKey / Token）将使用本机密钥加密存储</div>
        </div>
      )}
    </>
  )
}

function errMessage(err: unknown): string {
  const e = err as { error?: { message?: string } }
  return e?.error?.message ?? (err instanceof Error ? err.message : String(err))
}
