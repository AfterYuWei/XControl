// Tauri 桌面系统能力与 Electron 历史设置迁移。

import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

/** 是否运行在 Tauri 桌面环境（浏览器下为 false）。 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 应用引导初始化，必须在任何 store 模块导入之前 await 完成：
 * - Tauri：执行 Electron settings.json → localStorage 一次性迁移
 * - 浏览器：立即返回
 */
export async function initDesktop(): Promise<void> {
  if (!isTauri()) return
  await migrateElectronSettings()
}

/**
 * Electron settings.json → localStorage 一次性迁移（见 Rust settings_migrate.rs）。
 * Electron 的 settings.json 结构为 {"xcontrol-settings": "<zustand persist JSON>"}，
 * 与 localStorage 键值完全同构；仅当 localStorage 尚无数据时写入，失败不阻塞启动。
 */
async function migrateElectronSettings(): Promise<void> {
  try {
    const legacy = await invoke<Record<string, string> | null>('migrate_electron_settings')
    if (!legacy) return
    const persisted = legacy?.['xcontrol-settings']
    if (persisted && !localStorage.getItem('xcontrol-settings')) {
      localStorage.setItem('xcontrol-settings', persisted)
    }
    // 只有 localStorage 写入成功（或已经存在更新设置）后才确认，失败时下次启动重试。
    await invoke('mark_electron_settings_migrated')
  } catch {
    // 迁移失败不阻塞启动，保持默认设置
  }
}

// ─── 系统能力（外链 / 磁盘保存） ────────────────────────────────────────────

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
 * 桌面端将前端生成的文本内容（如私钥）保存到磁盘。返回保存路径；取消返回 null。
 */
export async function saveTextToDisk(
  content: string,
  suggestedName: string,
): Promise<string | null> {
  const bytes = Array.from(new TextEncoder().encode(content))
  return await invoke<string | null>('save_blob_to_disk', { bytes, suggestedName })
}

// ─── SFTP 拖出 ──────────────────────────────────────────────────────────────

/** Rust 物化远程文件的结果：本机文件路径列表 + 原生拖拽预览图标路径。 */
export interface DragOutResult {
  files: string[]
  icon: string
}

/**
 * 桌面端拖出第一步：让 Rust 把远程文件物化到临时目录
 * Rust 进程内把远程内容写入临时目录，随后启动 OS 级拖拽。
 */
export async function sftpDragOut(
  sourceSessionId: string,
  localSessionId: string,
  paths: string[],
): Promise<DragOutResult> {
  return await invoke<DragOutResult>('sftp_drag_out', {
    sourceSessionId,
    localSessionId,
    paths,
  })
}

/** 桌面端拖出第二步：从当前光标位置启动原生文件拖拽（crabnebula drag 插件）。 */
export async function startNativeFileDrag(files: string[], icon: string): Promise<void> {
  const { startDrag } = await import('@crabnebula/tauri-plugin-drag')
  await startDrag({ item: files, icon })
}
