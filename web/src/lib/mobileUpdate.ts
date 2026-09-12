// 移动端更新检查（stable/test 双通道）。
//
// Tauri updater 插件不支持 Android/iOS（见插件平台支持表），移动端无法应用内
// 安装，因此走「GitHub Releases 检查 + 浏览器打开发布页引导下载」：
// - test 通道：dev 分支流水线发布的 prerelease，tag 为 `test-v*`，
//   APK 资产名 `eizhu-<version>-android-arm64-debug.apk`；
// - stable 通道：main 分支流水线发布的正式 Release，tag 为 `v*`，
//   APK 资产名 `eizhu-<version>-android-arm64-release.apk`。
// 移动端版本号独立于桌面端（VERSION_MOBILE），test 构建带
// `-test.<提交计数>.<短SHA>` 后缀，保证单调递增。

import { appVersion, buildChannel } from './updater'
import { isMobileRuntime } from './platform'
import { openExternal } from './desktop'
import { toast } from 'sonner'
import type { UpdateChannel } from '@/store/settings'

export const MOBILE_REPO = 'AfterYuWei/eizhu'

export interface MobileUpdateCheckResult {
  /** 是否有可安装的更新（跨通道切换时始终视为有）。 */
  available: boolean
  /** 当前应用版本（展示用）。 */
  version: string
  /** 新版本号（无更新/请求失败时为空）。 */
  newVersion: string
  /** APK 直接下载地址；取不到资产链接时回退为发布页地址。 */
  url: string
}

/**
 * SemVer 比较版本号：支持 `x.y.z` 与 `x.y.z-test.<数字>.<短SHA>` 后缀。
 * 先比主次修订号，再按 SemVer 规则比较 pre-release（无后缀 > 有后缀；
 * pre-release 按 `.` 逐段比较，数字段按数值，文本段按字典序）。
 */
export function compareMobileVersions(a: string, b: string): number {
  const [coreA, preA = ''] = a.split('-')
  const [coreB, preB = ''] = b.split('-')
  const ca = coreA.split('.').map(Number)
  const cb = coreB.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (ca[i] || 0) - (cb[i] || 0)
    if (diff !== 0) return diff
  }
  const sa = preA ? preA.split('.') : []
  const sb = preB ? preB.split('.') : []
  if (sa.length !== sb.length) return sb.length - sa.length // 无后缀 > 有后缀
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] === sb[i]) continue
    const na = Number(sa[i])
    const nb = Number(sb[i])
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
    return sa[i] < sb[i] ? -1 : 1
  }
  return 0
}

/** 从 APK 资产名提取移动端版本号，如 `eizhu-0.4.2-test.12.ab12cd3-android-arm64-debug.apk`。 */
export function versionFromApkAsset(name: string): string | null {
  const match = name.match(/^eizhu-(.+)-android-arm64-(?:debug|release)\.apk$/)
  return match ? match[1] : null
}

/** 从 Release 列表中找出指定通道的最新移动端发布，返回 APK 直链（缺失时回退发布页）。 */
export function pickMobileRelease(
  releases: Array<{
    tag_name: string
    prerelease: boolean
    html_url: string
    assets: Array<{ name: string; browser_download_url: string }>
  }>,
  channel: UpdateChannel,
): { version: string; url: string } | null {
  for (const release of releases) {
    const isTest = release.prerelease && release.tag_name.startsWith('test-v')
    const isStable = !release.prerelease && /^v\d/.test(release.tag_name)
    if (channel === 'test' ? !isTest : !isStable) continue
    for (const asset of release.assets) {
      const version = versionFromApkAsset(asset.name)
      if (version) {
        return { version, url: asset.browser_download_url || release.html_url }
      }
    }
  }
  return null
}

/**
 * 检查移动端更新：查询 GitHub Releases 的最新 APK 资产。
 * 同通道内严格单调升级；选择不同于构建通道的通道时始终提示（允许切换）。
 */
export async function checkMobileUpdate(
  channel: UpdateChannel = buildChannel,
): Promise<MobileUpdateCheckResult> {
  const version = await appVersion()
  if (!isMobileRuntime()) return { available: false, version, newVersion: '', url: '' }
  const releases = await fetchReleases()
  const latest = pickMobileRelease(releases, channel)
  if (!latest) return { available: false, version, newVersion: '', url: '' }
  const available = channel !== buildChannel || compareMobileVersions(latest.version, version) > 0
  return { available, version, newVersion: latest.version, url: latest.url }
}

async function fetchReleases(): Promise<Parameters<typeof pickMobileRelease>[0]> {
  const response = await fetch(
    `https://api.github.com/repos/${MOBILE_REPO}/releases?per_page=30`,
    { headers: { Accept: 'application/vnd.github+json' } },
  )
  if (!response.ok) throw new Error(`GitHub API ${response.status}`)
  return response.json()
}

/** 用系统浏览器打开 APK 下载链接（或发布页回退地址）。 */
export function openMobileReleasePage(url: string): void {
  if (url) void openExternal(url)
}

/**
 * 启动静默检查（延迟 10s 避免抢启动带宽，与桌面端一致）：
 * 有更新时 toast 引导浏览器直接下载 APK。
 */
export function scheduleSilentMobileUpdateCheck(enabled: boolean): void {
  if (!enabled || !isMobileRuntime()) return
  window.setTimeout(() => {
    void checkMobileUpdate()
      .then((result) => {
        if (!result.available) return
        toast.info(`发现新版本 ${result.newVersion}`, {
          description: '点击开始下载安装包',
          duration: 15000,
          action: { label: '下载', onClick: () => openMobileReleasePage(result.url) },
        })
      })
      .catch(() => {
        // 静默检查失败不打扰用户（网络离线等）
      })
  }, 10_000)
}
