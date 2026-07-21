import { useCallback, useEffect, useState } from 'react'
import {
  CloudSync, RefreshCw, History, Settings2, KeyRound, Clock,
  RotateCcw, Trash2, Loader2, CheckCircle2, AlertTriangle, Timer,
  CloudUpload, ArrowDownToLine, ArrowUpToLine, Server,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toast'
import { syncApi } from '@/api/sync'
import type {
  SyncSettings, SyncStatus, SyncVersion,
} from '@/types/sync'
import { ORIGIN_LABELS, formatSize } from '@/types/sync'
import { ProviderSection } from './ProviderForm'

const syncModeOptions = [
  { value: 'auto', label: '自动双向同步' },
  { value: 'manual', label: '手动推送 / 拉取' },
]
const conflictOptions = [
  { value: 'prompt', label: '提示我手动解决（推荐）' },
  { value: 'latest', label: '以最新时间戳为准' },
]
const retentionOptions = [
  { value: 'keep_forever', label: '云端永久保留（推荐）' },
  { value: 'mirror_local', label: '云端跟随本地清理' },
]

export function SyncPanel() {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [versions, setVersions] = useState<SyncVersion[]>([])
  const [settings, setSettings] = useState<SyncSettings | null>(null)
  const [password, setPassword] = useState('')
  const [backingUp, setBackingUp] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [busyVersionId, setBusyVersionId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [resolving, setResolving] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [st, vs, se] = await Promise.all([
        syncApi.status(),
        syncApi.versions(),
        syncApi.settings(),
      ])
      setStatus(st)
      setVersions(vs ?? [])
      setSettings(se)
    } catch (err) {
      console.error('load sync state failed', err)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 0)
    return () => clearTimeout(t)
  }, [refresh])

  // Register the exit-backup beacon once.
  useEffect(() => {
    const handler = () => {
      if (settings?.auto_backup_enabled) syncApi.notifyShutdown()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [settings?.auto_backup_enabled])

  const handleBackupNow = async () => {
    setBackingUp(true)
    try {
      const res = await syncApi.backupNow()
      if (res.created && res.version) {
        toast.success(`已创建版本 v${res.version.version}`, {
          description: formatSize(res.version.size),
        })
      } else {
        toast.info(res.message ?? '没有需要备份的变更')
      }
      void refresh()
    } catch (err) {
      toast.error('备份失败', { description: errMessage(err) })
    } finally {
      setBackingUp(false)
    }
  }

  const handleRestore = async (v: SyncVersion) => {
    if (!window.confirm(`将当前数据恢复为 v${v.version}（${new Date(v.created_at).toLocaleString()}）？\n现有数据会被覆盖，此操作会生成一个新版本。`)) return
    setBusyVersionId(v.id)
    try {
      await syncApi.restoreVersion(v.id)
      toast.success(`已恢复为 v${v.version}`)
      void refresh()
    } catch (err) {
      toast.error('恢复失败', { description: errMessage(err) })
    } finally {
      setBusyVersionId(null)
    }
  }

  const handleDelete = async (v: SyncVersion, force: boolean) => {
    const hint = v.synced_to.length === 0 && !force
      ? ''
      : `\n该版本${v.synced_to.length === 0 ? '未同步到云端，删除后不可恢复！' : '将仅从本地删除。'}`
    if (!window.confirm(`删除版本 v${v.version}？${hint}`)) return
    setBusyVersionId(v.id)
    try {
      await syncApi.deleteVersion(v.id, force)
      toast.success(`已删除 v${v.version}`)
      void refresh()
    } catch (err) {
      const msg = errMessage(err)
      if (msg.includes('尚未同步') && !force) {
        if (window.confirm(`${msg}\n\n确定强制删除？`)) {
          await handleDelete(v, true)
          return
        }
      } else {
        toast.error('删除失败', { description: msg })
      }
    } finally {
      setBusyVersionId(null)
    }
  }

  const handleSyncNow = async () => {
    setSyncing(true)
    try {
      await syncApi.syncNow()
      toast.info('同步已开始，稍后自动完成')
      setTimeout(() => { void refresh(); setSyncing(false) }, 3000)
    } catch (err) {
      toast.error('同步失败', { description: errMessage(err) })
      setSyncing(false)
    }
  }

  const handleResolve = async (choice: 'keep_local' | 'use_cloud') => {
    const c = status?.conflict
    if (!c) return
    const msg = choice === 'keep_local'
      ? `保留本地 v${c.local.version}，以其为基准生成新版本并同步到云端 v${Math.max(c.local.version, c.cloud.version) + 1}？`
      : `采用云端 v${c.cloud.version}（本地数据将被覆盖），然后生成新版本同步双端？`
    if (!window.confirm(msg)) return
    setResolving(true)
    try {
      await syncApi.resolveConflict(choice)
      toast.success('冲突已解决，双端已收敛')
      void refresh()
    } catch (err) {
      toast.error('解决失败', { description: errMessage(err) })
    } finally {
      setResolving(false)
    }
  }

  const patch = <K extends keyof SyncSettings>(key: K, value: SyncSettings[K]) => {
    setSettings((s) => (s ? { ...s, [key]: value } : s))
  }

  const handleSaveSettings = async () => {
    if (!settings) return
    if (password && password.length < 6) {
      toast.warning('同步密码至少 6 位')
      return
    }
    setSavingSettings(true)
    try {
      await syncApi.updateSettings(settings, password || undefined)
      toast.success('同步设置已保存')
      setPassword('')
      void refresh()
    } catch (err) {
      toast.error('保存失败', { description: errMessage(err) })
    } finally {
      setSavingSettings(false)
    }
  }

  if (!settings || !status) {
    return (
      <div className="settings-section">
        <div className="backup-row"><Loader2 size={14} className="animate-spin" /><span className="settings-field-desc">加载同步状态…</span></div>
      </div>
    )
  }

  return (
    <div className="settings-section">
      {/* ── 状态卡片 ── */}
      <div className="settings-section-title">
        <CloudSync size={14} />
        <span>云同步与版本控制</span>
      </div>

      {/* 冲突横幅 */}
      {status.conflict && (
        <div className="backup-card sync-conflict-banner">
          <div className="backup-row">
            <AlertTriangle size={14} />
            <span style={{ fontWeight: 600 }}>版本冲突：本地 v{status.conflict.local.version} 与云端 v{status.conflict.cloud.version}（{status.conflict.provider_name}）已分叉</span>
          </div>
          <div className="backup-row" style={{ gap: 8 }}>
            <Button size="sm" variant="outline" disabled={resolving} onClick={() => void handleResolve('keep_local')}>
              {resolving ? <Loader2 size={12} className="animate-spin" /> : <ArrowUpToLine size={12} />}
              保留本地 v{status.conflict.local.version}
            </Button>
            <Button size="sm" variant="outline" disabled={resolving} onClick={() => void handleResolve('use_cloud')}>
              {resolving ? <Loader2 size={12} className="animate-spin" /> : <ArrowDownToLine size={12} />}
              采用云端 v{status.conflict.cloud.version}
            </Button>
            <span className="settings-field-desc">选择后双端将收敛到新版本</span>
          </div>
        </div>
      )}

      <div className="backup-card">
        <div className="sync-status-grid">
          <div className="sync-status-item">
            <span className="sync-status-label">本地当前版本</span>
            {status.local_latest ? (
              <span className="sync-status-value">
                v{status.local_latest.version}
                <em>{formatSize(status.local_latest.size)} · {new Date(status.local_latest.created_at).toLocaleString()}</em>
              </span>
            ) : (
              <span className="sync-status-value sync-status-empty">尚无版本</span>
            )}
          </div>
          <div className="sync-status-item">
            <span className="sync-status-label">云端最新版本</span>
            {status.providers.filter((p) => p.enabled).length === 0 ? (
              <span className="sync-status-value sync-status-empty">
                未配置云服务
                <em>在下方「云服务」中添加</em>
              </span>
            ) : (
              <span className="sync-status-value">
                {(() => {
                  const latest = Object.values(status.cloud_latest).sort((a, b) => b.version - a.version)[0]
                  return latest ? (
                    <>v{latest.version}
                      <em>{formatSize(latest.size)} · {new Date(latest.created_at).toLocaleString()}</em>
                    </>
                  ) : (
                    <span className="sync-status-empty">云端尚无版本</span>
                  )
                })()}
              </span>
            )}
          </div>
        </div>
        <div className="backup-row" style={{ justifyContent: 'space-between' }}>
          <span className="settings-field-desc">
            {status.last_sync_at ? `上次同步：${new Date(status.last_sync_at).toLocaleString()}` : '尚未执行过同步'}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button onClick={handleBackupNow} disabled={backingUp || !settings.sync_password_set} size="sm" variant="outline">
              {backingUp ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              立即备份
            </Button>
            <Button onClick={handleSyncNow} disabled={syncing || !settings.sync_password_set || status.providers.filter((p) => p.enabled).length === 0} size="sm">
              {syncing ? <Loader2 size={13} className="animate-spin" /> : <CloudUpload size={13} />}
              立即同步
            </Button>
          </div>
        </div>
        {!settings.sync_password_set && (
          <div className="backup-warning">
            <KeyRound size={13} />
            <span>请先在下方「同步密码」中设置密码后才能创建加密版本</span>
          </div>
        )}
      </div>

      {/* ── 云服务 ── */}
      <div className="settings-divider" />
      <div className="settings-subsection-title"><Server size={13} style={{ marginRight: 4, verticalAlign: -2 }} />云服务</div>
      <ProviderSection providers={status.providers} onChanged={() => void refresh()} />

      {/* ── 同步密码 ── */}
      <div className="settings-field">
        <div className="settings-field-info">
          <Label className="settings-field-label">
            <KeyRound size={13} className="settings-field-icon" />
            同步密码
          </Label>
          <span className="settings-field-desc">
            {settings.sync_password_set ? '已设置（输入新密码可更换）' : '所有版本文件使用该密码加密（Argon2id + AES-256-GCM）'}
          </span>
        </div>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={settings.sync_password_set ? '留空保持不变' : '至少 6 位'}
          style={{ width: 180 }}
        />
      </div>

      {/* ── 同步策略 ── */}
      <div className="settings-divider" />
      <div className="settings-subsection-title"><Settings2 size={13} style={{ marginRight: 4, verticalAlign: -2 }} />同步策略</div>

      <div className="settings-field">
        <div className="settings-field-info">
          <Label className="settings-field-label">同步模式</Label>
          <span className="settings-field-desc">手动模式仅在点击按钮时同步；自动模式双向保持一致</span>
        </div>
        <Select options={syncModeOptions} value={settings.sync_mode}
          onChange={(v) => patch('sync_mode', v as SyncSettings['sync_mode'])} className="settings-select" />
      </div>
      <div className="settings-field">
        <div className="settings-field-info">
          <Label className="settings-field-label">版本冲突</Label>
          <span className="settings-field-desc">本地与云端分叉时的处理方式</span>
        </div>
        <Select options={conflictOptions} value={settings.conflict_policy}
          onChange={(v) => patch('conflict_policy', v as SyncSettings['conflict_policy'])} className="settings-select" />
      </div>
      <div className="settings-field">
        <div className="settings-field-info">
          <Label className="settings-field-label">云端清理</Label>
          <span className="settings-field-desc">本地清理旧版本时云端的行为（M2 生效）</span>
        </div>
        <Select options={retentionOptions} value={settings.cloud_retention}
          onChange={(v) => patch('cloud_retention', v as SyncSettings['cloud_retention'])} className="settings-select" />
      </div>
      <div className="settings-field">
        <div className="settings-field-info">
          <Label className="settings-field-label">本地保留版本数</Label>
          <span className="settings-field-desc">超出后按 FIFO 清理最旧版本（未同步到云端的版本不会被清理）；0 = 不限制</span>
        </div>
        <div className="settings-number-group">
          <Input type="number" min={0} max={500} value={settings.local_keep_versions}
            onChange={(e) => patch('local_keep_versions', Math.max(0, Number(e.target.value) || 0))}
            className="settings-number-input" />
          <span className="settings-number-unit">个</span>
        </div>
      </div>

      {/* ── 定时备份 ── */}
      <div className="settings-divider" />
      <div className="settings-subsection-title"><Timer size={13} style={{ marginRight: 4, verticalAlign: -2 }} />定时备份</div>

      <div className="settings-field">
        <div className="settings-field-info">
          <Label className="settings-field-label">启用定时备份</Label>
          <span className="settings-field-desc">按下方规则自动创建版本</span>
        </div>
        <Switch checked={settings.scheduled_enabled}
          onCheckedChange={(v) => patch('scheduled_enabled', v)} />
      </div>
      {settings.scheduled_enabled && (
        <>
          <div className="settings-field">
            <div className="settings-field-info">
              <Label className="settings-field-label">
                <Clock size={13} className="settings-field-icon" />
                间隔备份
              </Label>
              <span className="settings-field-desc">每隔 X 小时备份一次；0 = 关闭</span>
            </div>
            <div className="settings-number-group">
              <Input type="number" min={0} max={720} value={settings.scheduled_interval_hours}
                onChange={(e) => patch('scheduled_interval_hours', Math.max(0, Number(e.target.value) || 0))}
                className="settings-number-input" />
              <span className="settings-number-unit">小时</span>
            </div>
          </div>
          <div className="settings-field">
            <div className="settings-field-info">
              <Label className="settings-field-label">每日定时</Label>
              <span className="settings-field-desc">每天在固定时间备份；留空 = 关闭</span>
            </div>
            <Input type="time" value={settings.scheduled_daily_time}
              onChange={(e) => patch('scheduled_daily_time', e.target.value)}
              style={{ width: 110 }} />
          </div>
        </>
      )}

      {/* ── 自动备份 ── */}
      <div className="settings-divider" />
      <div className="settings-subsection-title"><CheckCircle2 size={13} style={{ marginRight: 4, verticalAlign: -2 }} />自动备份</div>

      <div className="settings-field">
        <div className="settings-field-info">
          <Label className="settings-field-label">启用自动备份</Label>
          <span className="settings-field-desc">数据变更时（防抖合并）与应用退出时自动创建版本</span>
        </div>
        <Switch checked={settings.auto_backup_enabled}
          onCheckedChange={(v) => patch('auto_backup_enabled', v)} />
      </div>
      {settings.auto_backup_enabled && (
        <div className="settings-field">
          <div className="settings-field-info">
            <Label className="settings-field-label">变更防抖窗口</Label>
            <span className="settings-field-desc">连续变更在该窗口内合并为一次备份</span>
          </div>
          <div className="settings-number-group">
            <Input type="number" min={5} max={600} value={settings.change_debounce_seconds}
              onChange={(e) => patch('change_debounce_seconds', Math.max(5, Number(e.target.value) || 30))}
              className="settings-number-input" />
            <span className="settings-number-unit">秒</span>
          </div>
        </div>
      )}

      <Button onClick={handleSaveSettings} disabled={savingSettings} className="backup-action">
        {savingSettings ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
        保存设置
      </Button>

      {/* ── 版本历史 ── */}
      <div className="settings-divider" />
      <div className="settings-subsection-title"><History size={13} style={{ marginRight: 4, verticalAlign: -2 }} />版本历史（本地 {versions.length} 个）</div>

      {versions.length === 0 ? (
        <div className="backup-row"><span className="settings-field-desc">尚无版本。设置同步密码后点击「立即备份」创建第一个版本。</span></div>
      ) : (
        <div className="sync-version-list">
          {versions.map((v) => (
            <div key={v.id} className="sync-version-item">
              <div className="sync-version-info">
                <span className="sync-version-tag">v{v.version}</span>
                <span className="sync-version-meta">
                  {ORIGIN_LABELS[v.origin] ?? v.origin} · {formatSize(v.size)} · {new Date(v.created_at).toLocaleString()}
                </span>
                {v.synced_to.length === 0 && (
                  <span className="sync-version-unsynced" title="尚未同步到云端">
                    <AlertTriangle size={11} /> 仅本地
                  </span>
                )}
              </div>
              <div className="sync-version-actions">
                <Button variant="outline" size="sm" disabled={busyVersionId === v.id}
                  onClick={() => void handleRestore(v)}>
                  {busyVersionId === v.id ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                  恢复
                </Button>
                <Button variant="ghost" size="sm" disabled={busyVersionId === v.id}
                  onClick={() => void handleDelete(v, false)}>
                  <Trash2 size={12} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function errMessage(err: unknown): string {
  const e = err as { error?: { message?: string } }
  return e?.error?.message ?? (err instanceof Error ? err.message : String(err))
}
