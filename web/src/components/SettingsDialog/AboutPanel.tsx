import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Info, RefreshCw, Download } from 'lucide-react'
import { isTauri } from '@/lib/desktop'
import { appVersion, checkForUpdates, downloadAndInstallUpdate, type UpdateCheckResult } from '@/lib/updater'

/**
 * 「关于」面板：版本信息与应用内更新（P4，见 docs/TAURI_MIGRATION.md §8.2）。
 * 更新通道为 GitHub Releases stable（latest.json）；pre 版本在 stable 发布时
 * 会自动收到升级。deb/rpm 安装包不支持应用内更新（官方限制）。
 */
export function AboutPanel() {
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)

  useEffect(() => {
    void appVersion().then(setVersion)
  }, [])

  const handleCheck = async () => {
    setChecking(true)
    setResult(null)
    try {
      const checkResult = await checkForUpdates()
      setResult(checkResult)
      if (!checkResult.available) {
        toast.success('已是最新版本')
      }
    } catch (err) {
      toast.error('检查更新失败', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setChecking(false)
    }
  }

  const handleInstall = () => {
    setDownloading(true)
    setProgress(0)
    void toast.promise(
      downloadAndInstallUpdate((percent) => setProgress(percent)).finally(() => {
        // relaunch 成功则不会走到这里
        setDownloading(false)
      }),
      {
        loading: '正在下载并安装更新…',
        success: '更新完成，应用即将重启',
        error: (err) => `更新失败: ${err instanceof Error ? err.message : String(err)}`,
      },
    )
  }

  const desktop = isTauri()

  return (
    <div className="settings-section">
      <div className="settings-section-title">
        <Info size={14} />
        <span>关于 XControl</span>
      </div>

      <div className="settings-field">
        <div className="settings-field-info">
          <span className="settings-field-label">当前版本</span>
          <span className="settings-field-desc">
            {desktop
              ? '基于 Tauri 2 的桌面版（数据与旧版 Electron 自动兼容）'
              : '浏览器模式（网页版）'}
          </span>
        </div>
        <span className="about-version-value">{version || '—'}</span>
      </div>

      {desktop && (
        <div className="settings-field">
          <div className="settings-field-info">
            <span className="settings-field-label">软件更新</span>
            <span className="settings-field-desc">
              {downloading
                ? progress !== null
                  ? `正在下载更新… ${progress}%`
                  : '正在下载更新…'
                : result?.available
                  ? `发现新版本 ${result.newVersion}，建议尽快更新`
                  : '检查并安装来自 GitHub Releases 的稳定版更新'}
            </span>
          </div>
          {result?.available && !downloading ? (
            <Button onClick={handleInstall} className="settings-btn">
              <Download size={13} />
              安装更新
            </Button>
          ) : (
            <Button
              onClick={() => void handleCheck()}
              disabled={checking || downloading}
              className="settings-btn"
            >
              <RefreshCw size={13} className={checking ? 'animate-spin' : ''} />
              {checking ? '检查中…' : '检查更新'}
            </Button>
          )}
        </div>
      )}

      {result?.notes && (
        <div className="settings-field">
          <div className="settings-field-info">
            <span className="settings-field-label">更新说明</span>
            <span className="settings-field-desc about-release-notes">{result.notes}</span>
          </div>
        </div>
      )}
    </div>
  )
}
