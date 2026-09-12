import { describe, expect, it } from 'vitest'
import { compareMobileVersions, pickMobileRelease, versionFromApkAsset } from './mobileUpdate'

describe('compareMobileVersions', () => {
  it('比较主次修订号', () => {
    expect(compareMobileVersions('0.4.2', '0.4.1')).toBeGreaterThan(0)
    expect(compareMobileVersions('0.4.2', '0.5.0')).toBeLessThan(0)
    expect(compareMobileVersions('0.4.2', '0.4.2')).toBe(0)
  })

  it('正式版高于同号测试版', () => {
    expect(compareMobileVersions('0.4.2', '0.4.2-test.12.abc1234')).toBeGreaterThan(0)
    expect(compareMobileVersions('0.4.2-test.12.abc1234', '0.4.2')).toBeLessThan(0)
  })

  it('测试构建号按数值单调比较', () => {
    expect(compareMobileVersions('0.4.2-test.13.def5678', '0.4.2-test.12.abc1234')).toBeGreaterThan(0)
    expect(compareMobileVersions('0.4.2-test.9.aaa', '0.4.2-test.12.bbb')).toBeLessThan(0)
    expect(compareMobileVersions('0.4.2-test.12.abc1234', '0.4.2-test.12.abc1234')).toBe(0)
  })

  it('数值段不做字典序比较', () => {
    expect(compareMobileVersions('0.4.10', '0.4.9')).toBeGreaterThan(0)
  })
})

describe('versionFromApkAsset', () => {
  it('解析 debug/test APK 资产名', () => {
    expect(versionFromApkAsset('eizhu-0.4.2-test.12.abc1234-android-arm64-debug.apk'))
      .toBe('0.4.2-test.12.abc1234')
  })

  it('解析 release APK 资产名', () => {
    expect(versionFromApkAsset('eizhu-0.4.2-android-arm64-release.apk')).toBe('0.4.2')
  })

  it('忽略无关资产', () => {
    expect(versionFromApkAsset('eizhu-0.4.2-x64.msi')).toBeNull()
    expect(versionFromApkAsset('source-code.zip')).toBeNull()
  })
})

describe('pickMobileRelease', () => {
  const releases = [
    {
      tag_name: 'v0.4.1',
      prerelease: false,
      html_url: 'https://github.com/AfterYuWei/eizhu/releases/tag/v0.4.1',
      assets: [
        { name: 'eizhu-0.4.2-android-arm64-release.apk', browser_download_url: 'https://github.com/AfterYuWei/eizhu/releases/download/v0.4.1/eizhu-0.4.2-android-arm64-release.apk' },
        { name: 'eizhu-0.4.1-x64-setup.exe', browser_download_url: 'https://github.com/AfterYuWei/eizhu/releases/download/v0.4.1/eizhu-0.4.1-x64-setup.exe' },
      ],
    },
    {
      tag_name: 'test-v0.4.1-test.15.def5678',
      prerelease: true,
      html_url: 'https://github.com/AfterYuWei/eizhu/releases/tag/test-v0.4.1-test.15.def5678',
      assets: [
        { name: 'eizhu-0.4.2-test.15.def5678-android-arm64-debug.apk', browser_download_url: 'https://github.com/AfterYuWei/eizhu/releases/download/test-v0.4.1-test.15.def5678/eizhu-0.4.2-test.15.def5678-android-arm64-debug.apk' },
      ],
    },
    {
      tag_name: 'test-v0.4.1-test.14.bbb',
      prerelease: true,
      html_url: 'https://github.com/AfterYuWei/eizhu/releases/tag/test-v0.4.1-test.14.bbb',
      assets: [
        { name: 'eizhu-0.4.2-test.14.bbb-android-arm64-debug.apk', browser_download_url: 'https://github.com/AfterYuWei/eizhu/releases/download/test-v0.4.1-test.14.bbb/eizhu-0.4.2-test.14.bbb-android-arm64-debug.apk' },
      ],
    },
  ]

  it('stable 通道只取正式 Release，返回 APK 直链', () => {
    const result = pickMobileRelease(releases, 'stable')
    expect(result?.version).toBe('0.4.2')
    expect(result?.url).toContain('/download/v0.4.1/eizhu-0.4.2-android-arm64-release.apk')
  })

  it('test 通道取最新 prerelease，返回 APK 直链', () => {
    const result = pickMobileRelease(releases, 'test')
    expect(result?.version).toBe('0.4.2-test.15.def5678')
    expect(result?.url).toContain('test.15.def5678-android-arm64-debug.apk')
  })

  it('资产缺少直链时回退发布页地址', () => {
    const result = pickMobileRelease(
      [{
        tag_name: 'v0.4.1',
        prerelease: false,
        html_url: 'https://github.com/AfterYuWei/eizhu/releases/tag/v0.4.1',
        assets: [{ name: 'eizhu-0.4.2-android-arm64-release.apk', browser_download_url: '' }],
      }],
      'stable',
    )
    expect(result?.url).toContain('/tag/v0.4.1')
  })

  it('无匹配资产时返回 null', () => {
    expect(pickMobileRelease(
      [{ tag_name: 'v0.4.1', prerelease: false, html_url: '', assets: [{ name: 'x.msi', browser_download_url: '' }] }],
      'stable',
    )).toBeNull()
  })
})
