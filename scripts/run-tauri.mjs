#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const command = process.argv[2]
if (!['dev', 'build', 'android', 'ios'].includes(command)) {
  console.error('用法: node scripts/run-tauri.mjs <dev|build|android|ios> [Tauri 参数...]')
  process.exit(1)
}

// 桌面端与移动端版本分开源文件管理：VERSION 供 dev/build（桌面）使用，
// VERSION_MOBILE 供 android/ios（移动）使用；CI 可用环境变量精确覆盖。
const mobile = command === 'android' || command === 'ios'
const versionFile = mobile ? 'VERSION_MOBILE' : 'VERSION'
const versionEnv = mobile ? 'EIZHU_MOBILE_VERSION' : 'EIZHU_APP_VERSION'
const fileVersion = readFileSync(new URL(`../${versionFile}`, import.meta.url), 'utf8').trim()
const version = (process.env[versionEnv] || fileVersion).trim()
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`无效的应用版本（${versionFile}）: ${version}`)
  process.exit(1)
}

const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url))
// android/ios 的 --config 是最终子命令（init/dev/build）自己的选项，
// 必须放在参数末尾；桌面 dev/build 则紧随命令之后。
const args = mobile
  ? [command, ...process.argv.slice(3), '--config', JSON.stringify({ version })]
  : [command, '--config', JSON.stringify({ version }), ...process.argv.slice(3)]
console.log(`[eizhu] Tauri ${command} 版本（${versionFile}）: ${version}`)

// Invoke the JavaScript entrypoint with the current Node executable. Windows
// cannot spawn a .cmd shim directly with shell=false and returns EINVAL.
const result = spawnSync(process.execPath, [cli, ...args], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
})
if (result.error) {
  console.error(`无法启动 Tauri CLI: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
