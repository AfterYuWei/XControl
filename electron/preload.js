const { contextBridge, ipcRenderer } = require('electron')

// 桌面环境标识与版本信息
contextBridge.exposeInMainWorld('sshx', {
  desktop: true,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  // 窗口控制 API：通过 IPC 调用主进程，渲染层不直接持有 Node/Electron 能力
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:maximizeToggle'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    // 订阅最大化状态变化（系统快捷键/边缘拖拽/双击标题栏均会触发）
    onMaximizeChange: (callback) => {
      const handler = (_event, isMaximized) => callback(isMaximized)
      ipcRenderer.on('window:maximized', handler)
      // 返回取消订阅函数，避免重复注册导致内存泄漏
      return () => ipcRenderer.removeListener('window:maximized', handler)
    },
  },
})
