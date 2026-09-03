#!/usr/bin/env node
// 生成 Tauri updater 的 latest.json 清单（P4，见 docs/TAURI_MIGRATION.md §8.2）。
//
// 用法: node scripts/make-latest-json.mjs <version> <tag> <artifactsDir>
//
// 在 artifacts 目录中寻找各平台更新产物与对应 .sig（tauri build 开启
// createUpdaterArtifacts 时生成），组装 stable 通道清单：
//   Windows → NSIS setup exe 本体；macOS → .app.tar.gz（非 dmg）；
//   Linux → AppImage（deb/rpm 不支持应用内更新）。
// latest.json 只随 stable Release 发布，pre 版本经 semver 比较在 stable
// 发布时收到升级（pre 版本号 0.0.0-pre.<日期>.<sha> 保证单调）。
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'AfterYuWei/XControl'

const [, , version, tag, dir] = process.argv
if (!version || !tag || !dir) {
  console.error('用法: node scripts/make-latest-json.mjs <version> <tag> <artifactsDir>')
  process.exit(1)
}

const files = readdirSync(dir)
const sigOf = (name) => {
  const sigPath = join(dir, `${name}.sig`)
  if (!existsSync(sigPath)) {
    throw new Error(`缺少签名文件: ${name}.sig`)
  }
  return readFileSync(sigPath, 'utf8').trim()
}
const assetUrl = (name) =>
  `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`

const platforms = {}

const win = files.find((f) => f.endsWith('-setup.exe'))
if (win) platforms['windows-x86_64'] = { signature: sigOf(win), url: assetUrl(win) }

const mac = files.find((f) => f.endsWith('.app.tar.gz'))
if (mac) platforms['darwin-aarch64'] = { signature: sigOf(mac), url: assetUrl(mac) }

const linux = files.find((f) => f.endsWith('.AppImage'))
if (linux) platforms['linux-x86_64'] = { signature: sigOf(linux), url: assetUrl(linux) }

if (Object.keys(platforms).length === 0) {
  console.error('未找到任何平台更新产物')
  process.exit(1)
}

const manifest = {
  version,
  notes: `XControl ${version} 稳定版。完整更新说明见 Release 页面。`,
  pub_date: new Date().toISOString(),
  platforms,
}
writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest, null, 2))
console.log('[make-latest-json] 已生成:', Object.keys(platforms).join(', '))
