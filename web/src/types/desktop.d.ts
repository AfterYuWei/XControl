// 桌面环境（Electron）注入的 window.sshx 类型声明。
// 浏览器环境下 window.sshx 为 undefined，访问时需做存在性判断。

export interface WindowControlAPI {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<boolean>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void
}

export interface SshxDesktop {
  desktop: true
  // 平台标识：darwin=macOS, win32=Windows, linux=Linux
  platform: NodeJS.Platform
  versions: {
    electron: string
    chrome: string
    node: string
  }
  window: WindowControlAPI
}

declare global {
  interface Window {
    sshx?: SshxDesktop
  }
}

export {}
