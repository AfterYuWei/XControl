#!/usr/bin/env node
// Tauri 构建前置准备：前端构建（可选）→ Go sidecar 编译 → externalBin triple 重命名拷贝。
//
// 用法：
//   node scripts/prepare-sidecar.mjs --build    # 完整构建（tauri.conf.json 的 beforeBuildCommand 自动调用）
//   node scripts/prepare-sidecar.mjs --go-only  # 仅 Go 编译 + 拷贝（npm run desktop:dev 前置）
//
// 设计说明（docs/TAURI_MIGRATION.md §7.2）：
// - 前端产物输出到 server/web_dist，同时供 Tauri frontendDist 与 Go go:embed 使用，单一构建路径
// - sidecar 用 -tags prod 构建：配置完全由环境变量驱动（dev 构建会强制 debug 日志，见方案 §1.9）
// - externalBin 要求二进制带 target-triple 后缀，如 xcontrol-server-x86_64-pc-windows-msvc.exe
import { execSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv.includes('--build') ? 'build' : 'go-only'
const exeSuffix = process.platform === 'win32' ? '.exe' : ''

function run(command, cwd = root, env = {}) {
  console.log(`[prepare-sidecar] ${command} (cwd: ${cwd})`)
  execSync(command, { stdio: 'inherit', cwd, env: { ...process.env, ...env } })
}

function targetTriple() {
  try {
    const versionInfo = execSync('rustc -vV', { encoding: 'utf8' })
    const match = versionInfo.match(/^host:\s*(\S+)$/m)
    if (match) return match[1]
  } catch {
    // rustc 不可用时按平台推导（三平台均为本机构建，覆盖实际使用的全部组合）
  }
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  }
  return process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
}

// 1. 前端构建（tsc 类型检查 + vite 构建，输出 server/web_dist）
if (mode === 'build') {
  if (!existsSync(join(root, 'web/node_modules'))) {
    run('npm ci', join(root, 'web'))
  }
  run('npm run build', join(root, 'web'))
}

// 2. 编译 Go sidecar（纯 Go SQLite，无需 CGO）
run(
  `go build -tags prod -o xcontrol-server${exeSuffix} .`,
  join(root, 'server'),
  { CGO_ENABLED: '0' },
)

// 3. 拷贝为 externalBin 要求的 target-triple 命名
const triple = targetTriple()
const binariesDir = join(root, 'src-tauri/binaries')
mkdirSync(binariesDir, { recursive: true })
const source = join(root, `server/xcontrol-server${exeSuffix}`)
const target = join(binariesDir, `xcontrol-server-${triple}${exeSuffix}`)
copyFileSync(source, target)
if (process.platform !== 'win32') {
  // copyFileSync 不保证复制全部元数据；externalBin 在 macOS/Linux 必须保留执行位。
  chmodSync(target, 0o755)
}
console.log(`[prepare-sidecar] sidecar 就绪 → src-tauri/binaries/xcontrol-server-${triple}${exeSuffix}`)
