#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const command = process.argv[2]
if (!['dev', 'build'].includes(command)) {
  console.error('用法: node scripts/run-tauri.mjs <dev|build> [Tauri 参数...]')
  process.exit(1)
}

const fileVersion = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim()
const version = (process.env.XCONTROL_APP_VERSION || fileVersion).trim()
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`无效的应用版本: ${version}`)
  process.exit(1)
}

const executable = process.platform === 'win32' ? 'tauri.cmd' : 'tauri'
const args = [command, '--config', JSON.stringify({ version }), ...process.argv.slice(3)]
console.log(`[XControl] Tauri ${command} 版本: ${version}`)

const result = spawnSync(executable, args, {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
})
if (result.error) {
  console.error(`无法启动 Tauri CLI: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
