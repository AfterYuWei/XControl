// 桌面桥（Tauri）与浏览器环境的统一抽象。见 docs/TAURI_MIGRATION.md §6.1。
//
// 职责：
// - 探测运行环境（Tauri WebView vs 浏览器）
// - bootstrap 阶段获取后端连接信息（端口 + 访问令牌），并完成 Electron 设置一次性迁移
// - 为 REST/WS 请求提供 base URL、鉴权头与 WS URL 构造
//
// 浏览器模式（dev 由 Vite 代理 / 独立服务器模式同源直连）下所有函数均为直通行为。

import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

interface BackendInfo {
  port: number
  token: string
}

/** 模块级后端连接信息（Tauri 下由 initDesktop 写入；浏览器下恒为 null）。 */
let backendInfo: BackendInfo | null = null

/** 是否运行在 Tauri 桌面环境（浏览器下为 false）。 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 应用引导初始化，必须在任何 store 模块导入之前 await 完成：
 * - Tauri：阻塞等待后端就绪（Rust 侧 get_backend_info，含 15s 健康轮询）并记录端口/令牌；
 *   随后执行 Electron settings.json → localStorage 一次性迁移
 * - 浏览器：立即返回
 */
export async function initDesktop(): Promise<void> {
  if (!isTauri()) return
  backendInfo = await invoke<BackendInfo>('get_backend_info')
  await migrateElectronSettings()
}

/** REST 请求 base（Tauri 下指向本机 sidecar；浏览器下为空串走同源/代理）。 */
export function apiBase(): string {
  return backendInfo ? `http://127.0.0.1:${backendInfo.port}` : ''
}

/** 需要附加到所有 REST 请求的鉴权头（浏览器下为空对象）。 */
export function authHeaders(): Record<string, string> {
  return backendInfo ? { Authorization: `Bearer ${backendInfo.token}` } : {}
}

/**
 * 构造 WebSocket URL。
 * - Tauri：ws://127.0.0.1:<port><path>?<params>&access_token=<token>
 *   （浏览器 WebSocket API 无法携带自定义 Header，鉴权走 query 参数）
 * - 浏览器：同源 ws/wss + params（dev 由 Vite 代理转发）
 */
export function wsUrl(path: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params)
  if (backendInfo) {
    search.set('access_token', backendInfo.token)
    return `ws://127.0.0.1:${backendInfo.port}${path}?${search.toString()}`
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const qs = search.toString()
  return `${protocol}//${window.location.host}${path}${qs ? `?${qs}` : ''}`
}

/**
 * Electron settings.json → localStorage 一次性迁移（见 Rust settings_migrate.rs 与方案 §9.2）。
 * Electron 的 settings.json 结构为 {"xcontrol-settings": "<zustand persist JSON>"}，
 * 与 localStorage 键值完全同构；仅当 localStorage 尚无数据时写入，失败不阻塞启动。
 */
async function migrateElectronSettings(): Promise<void> {
  try {
    const legacy = await invoke<Record<string, string> | null>('migrate_electron_settings')
    const persisted = legacy?.['xcontrol-settings']
    if (persisted && !localStorage.getItem('xcontrol-settings')) {
      localStorage.setItem('xcontrol-settings', persisted)
    }
  } catch {
    // 迁移失败不阻塞启动，保持默认设置
  }
}

// ─── P2：系统能力（外链 / 磁盘保存，方案 §6.4/§6.1） ────────────────────────

/**
 * 在系统默认浏览器打开外部链接（等价 Electron shell.openExternal）。
 * 终端 OSC 8/WebLinks 超链接与 OAuth 授权弹窗均走此处；
 * 浏览器模式退化为 window.open。
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    await openUrl(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/**
 * 桌面端将后端文件保存到磁盘：Rust 侧流式拉取（Bearer）+ 系统保存对话框，
 * 文件内容不经过 IPC。返回最终保存路径；用户取消返回 null。
 * 用于备份导出等（WKWebView/WebKitGTK 下 blob + <a download> 不可靠）。
 */
export async function saveApiFileToDisk(
  apiPath: string,
  suggestedName: string,
): Promise<string | null> {
  return await invoke<string | null>('save_url_to_disk', { apiPath, suggestedName })
}

/**
 * 桌面端将前端生成的文本内容（如私钥）保存到磁盘。返回保存路径；取消返回 null。
 */
export async function saveTextToDisk(
  content: string,
  suggestedName: string,
): Promise<string | null> {
  const bytes = Array.from(new TextEncoder().encode(content))
  return await invoke<string | null>('save_blob_to_disk', { bytes, suggestedName })
}
