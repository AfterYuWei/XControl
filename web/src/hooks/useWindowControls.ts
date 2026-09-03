import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from '@/lib/desktop'

// 桌面环境标识与平台探测。
// 平台用 navigator.userAgent 判定（WKWebView/WebView2/WebKitGTK 的 UA 均含明确标识），
// 而非 invoke('get_platform')——标题栏布局是同步渲染决策，不能等异步返回。

/** 是否运行在 Tauri 桌面环境（浏览器下为 false）。 */
export function isDesktop(): boolean {
  return isTauri()
}

/** 是否为 macOS（使用系统原生交通灯，不自绘控制按钮）。 */
export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Macintosh|Mac OS X/i.test(navigator.userAgent)
}

/** 当前平台：macos / windows / linux；浏览器下为空串。 */
export function getPlatform(): string {
  if (!isDesktop()) return ''
  if (isMac()) return 'macos'
  return /Windows/i.test(navigator.userAgent) ? 'windows' : 'linux'
}

// 窗口控制 hook：仅桌面环境下可用。
// - 返回当前最大化状态与控制动作、平台信息
// - 订阅 onResized 后重查 isMaximized()，覆盖系统快捷键(Win+↑/↓)、
//   边缘拖拽、双击标题栏等所有最大化触发路径
// 浏览器环境下返回 disabled 态，调用控制动作为 no-op。
export function useWindowControls() {
  const desktop = isDesktop()
  const mac = isMac()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!desktop || mac) return

    const currentWindow = getCurrentWindow()
    let unlisten: (() => void) | undefined

    // 初始查询当前最大化状态
    currentWindow.isMaximized().then(setMaximized).catch(() => {})

    // 后续尺寸变化时重查（maximize/unmaximize 都会触发 resized）
    void currentWindow
      .onResized(() => {
        currentWindow.isMaximized().then(setMaximized).catch(() => {})
      })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})

    return () => unlisten?.()
  }, [desktop, mac])

  const minimize = () => {
    void getCurrentWindow().minimize()
  }
  const toggleMaximize = () => {
    void getCurrentWindow().toggleMaximize()
  }
  const close = () => {
    void getCurrentWindow().close()
  }

  // macOS 用系统交通灯，showControls=false；Windows/Linux 自绘按钮
  return { desktop, mac, showControls: desktop && !mac, maximized, minimize, toggleMaximize, close }
}
