import { useEffect, useState } from 'react'

// 是否运行在 Electron 桌面环境。浏览器下 window.xcontrol 为 undefined。
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && !!window.xcontrol?.desktop
}

// 当前平台：darwin / win32 / linux。浏览器下为空串。
// 用于决定窗口控制按钮的布局：macOS 用系统交通灯，Windows/Linux 自绘右侧按钮。
export function getPlatform(): string {
  return typeof window !== 'undefined' ? window.xcontrol?.platform ?? '' : ''
}

// 是否为 macOS（使用系统原生交通灯，不自绘控制按钮）
export function isMac(): boolean {
  return getPlatform() === 'darwin'
}

// 窗口控制 hook：仅在桌面环境下可用。
// - 返回当前最大化状态与控制动作、平台信息
// - 订阅主进程的 maximize/unmaximize 事件，自动同步系统快捷键(Win+↑/↓)、
//   边缘拖拽最大化、双击标题栏触发的状态变化
// 浏览器环境下返回 disabled 态，调用控制动作为 no-op。
export function useWindowControls() {
  const desktop = isDesktop()
  const mac = isMac()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!desktop || mac || !window.xcontrol?.window) return

    // 初始查询当前最大化状态
    window.xcontrol.window.isMaximized().then(setMaximized).catch(() => {})

    // 订阅后续状态变化
    const unsubscribe = window.xcontrol.window.onMaximizeChange((isMaximized) => {
      setMaximized(isMaximized)
    })

    return unsubscribe
  }, [desktop, mac])

  const minimize = () => {
    window.xcontrol?.window?.minimize()
  }
  const toggleMaximize = () => {
    window.xcontrol?.window?.toggleMaximize()
  }
  const close = () => {
    window.xcontrol?.window?.close()
  }

  // macOS 用系统交通灯，showControls=false；Windows/Linux 自绘按钮
  return { desktop, mac, showControls: desktop && !mac, maximized, minimize, toggleMaximize, close }
}
