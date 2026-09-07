// 应用内更新（P4，见 docs/TAURI_MIGRATION.md §8.2）。
//
// 通道策略：endpoint 指向固定的 tauri-update-channel Release，并用自定义
// target 区分 stable/test 与平台。选择不同于当前构建的通道时允许跨通道降级，
// 同一通道内仍严格执行 semver 单调更新。
// 平台支持：Windows NSIS / macOS app.tar.gz / Linux AppImage；
// deb/rpm 不支持应用内更新（官方限制，发布说明已明示）。

import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { getVersion } from '@tauri-apps/api/app'
import { isTauri } from './desktop'
import { toast } from 'sonner'
import { invoke } from '@tauri-apps/api/core'
import type { UpdateChannel } from '@/store/settings'

export type { UpdateChannel }

/** 当前安装包的构建通道；开发环境按测试版处理。 */
export const buildChannel: UpdateChannel =
  import.meta.env.VITE_XCONTROL_CHANNEL === 'test' || import.meta.env.DEV ? 'test' : 'stable'

export function isTestBuild(): boolean {
  return buildChannel === 'test'
}

function preferredUpdateChannel(): UpdateChannel {
  try {
    const raw = localStorage.getItem('xcontrol-settings')
    const channel = raw ? JSON.parse(raw)?.state?.updateChannel : undefined
    return channel === 'test' || channel === 'stable' ? channel : buildChannel
  } catch {
    return buildChannel
  }
}

async function updateTarget(channel: UpdateChannel): Promise<string> {
  const os = await invoke<string>('get_platform')
  const platform = os === 'windows'
    ? 'windows-x86_64'
    : os === 'macos'
      ? 'darwin-aarch64'
      : 'linux-x86_64'
  return `${channel}-${platform}`
}

async function checkChannel(channel: UpdateChannel): Promise<Update | null> {
  return check({
    target: await updateTarget(channel),
    // test 版的 0.0.0-test.* 可能低于已安装 stable；只有明确切换通道时
    // 才允许这种跨通道安装，避免同通道误降级。
    allowDowngrades: channel !== buildChannel,
  })
}

/** 当前应用版本（桌面端）；浏览器下返回空串。 */
export async function appVersion(): Promise<string> {
  if (!isTauri()) return ''
  try {
    return await getVersion()
  } catch {
    return ''
  }
}

export interface UpdateCheckResult {
  /** 是否有可用更新。 */
  available: boolean
  /** 当前版本（展示用）。 */
  version: string
  /** 新版本号（无更新时为空）。 */
  newVersion: string
  /** 更新说明（无更新时为空）。 */
  notes: string
}

/** 检查更新（不下载）。 */
export async function checkForUpdates(channel: UpdateChannel = preferredUpdateChannel()): Promise<UpdateCheckResult> {
  const version = await appVersion()
  if (!isTauri()) return { available: false, version, newVersion: '', notes: '' }
  const update: Update | null = await checkChannel(channel)
  return {
    available: Boolean(update?.available),
    version,
    newVersion: update?.version ?? '',
    notes: update?.body ?? '',
  }
}

/** 下载并安装更新，完成后重启应用。 */
export async function downloadAndInstallUpdate(
  channel: UpdateChannel = preferredUpdateChannel(),
  onProgress?: (percent: number) => void,
): Promise<void> {
  const update = await checkChannel(channel)
  if (!update?.available) throw new Error('没有可用更新')
  let total: number | null = null
  let received = 0
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? null
        break
      case 'Progress':
        received += event.data.chunkLength
        if (total) onProgress?.(Math.min(99, Math.round((received / total) * 100)))
        break
      case 'Finished':
        onProgress?.(100)
        break
    }
  })
  await relaunch()
}

/** 启动静默检查（延迟 10s 避免抢启动带宽）：有更新时 toast 提示一键升级。 */
export function scheduleSilentUpdateCheck(): void {
  if (!isTauri()) return
  window.setTimeout(() => {
    const channel = preferredUpdateChannel()
    void checkForUpdates(channel)
      .then((result) => {
        if (!result.available) return
        toast.info(`发现新版本 ${result.newVersion}`, {
          description: '建议尽快更新',
          duration: 15000,
          action: {
            label: '立即更新',
            onClick: () => {
              void toast.promise(downloadAndInstallUpdate(channel), {
                loading: '正在下载更新…',
                success: '更新完成，即将重启',
                error: (err) => `更新失败: ${err instanceof Error ? err.message : String(err)}`,
              })
            },
          },
        })
      })
      .catch(() => {
        // 静默检查失败不打扰用户（网络离线等）
      })
  }, 10_000)
}
