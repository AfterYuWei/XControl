// 桌面端（Tauri）外部文件拖入（P3，见 docs/TAURI_MIGRATION.md §6.7）。
//
// Tauri dragDropEnabled=true 时 WebView 拦截 OS 级拖放（HTML5 dataTransfer
// 拿不到文件），改用 webview 级 onDragDropEvent：直接提供 OS 真实路径，
// 文件夹拖入也天然支持（后端跨会话传输 directory_mode: preserve）。
// 浏览器模式不挂载，保留 FilePane 的 HTML5 拖入路径。

import { useEffect } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { toast } from 'sonner'
import { isTauri } from '@/lib/desktop'
import { hitTestDropTarget } from '@/lib/dragRegistry'
import type { SftpStoreApi, SftpStore } from '@/store/sftp'

/** 从任一面板找到本机文件会话（SftpView 左侧默认自动连接）。 */
function findLocalSessionId(state: SftpStore): string | undefined {
  return [...state.leftTabs, ...state.rightTabs]
    .find((tab) => tab.server.id === 'local' && tab.sessionId)?.sessionId ?? undefined
}

/**
 * 在 SftpView 挂载：监听 webview 拖放事件，把外部文件路径导入命中的 SFTP 目标。
 * 悬停高亮通过 store.externalHover 驱动（FilePane 统一渲染）。
 */
export function useExternalDrop(store: SftpStoreApi) {
  useEffect(() => {
    if (!isTauri()) return

    let disposed = false
    let unlisten: (() => void) | undefined
    // 'over' 事件不带 paths（仅 enter/drop 带），计数从 enter 携带
    let pathCount = 0

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const state = store.getState()
        const payload = event.payload
        if (payload.type === 'drop') {
          state.setExternalHover(null, 0)
          if (payload.paths.length === 0) return
          // onDragDropEvent 给的是物理像素，hitTest 需要 CSS 像素
          const scale = window.devicePixelRatio || 1
          const hit = hitTestDropTarget(payload.position.x / scale, payload.position.y / scale)
          if (hit?.kind !== 'sftp' || !hit.target.sessionId) return
          const localSessionId = findLocalSessionId(state)
          if (!localSessionId) {
            toast.warning('本机文件会话尚未连接，无法导入外部文件')
            return
          }
          // 走后端跨会话传输：本机会话 → 目标服务器（路径直达，含文件夹）
          void state.importExternalPaths(localSessionId, payload.paths, hit.target)
        } else if (payload.type === 'enter') {
          pathCount = payload.paths.length
          const scale = window.devicePixelRatio || 1
          const hit = hitTestDropTarget(payload.position.x / scale, payload.position.y / scale)
          state.setExternalHover(hit?.kind === 'sftp' ? hit.target : null, pathCount)
        } else if (payload.type === 'over') {
          const scale = window.devicePixelRatio || 1
          const hit = hitTestDropTarget(payload.position.x / scale, payload.position.y / scale)
          state.setExternalHover(hit?.kind === 'sftp' ? hit.target : null, pathCount)
        } else {
          // leave
          state.setExternalHover(null, 0)
        }
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      .catch(() => {})

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [store])
}
