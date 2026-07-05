const { contextBridge, ipcRenderer } = require('electron')

// 桌面环境标识、平台信息与版本信息
contextBridge.exposeInMainWorld('xcontrol', {
  desktop: true,
  // 平台标识：渲染层据此决定控制按钮布局
  // darwin=macOS(用系统交通灯), win32=Windows(右侧自绘), linux=Linux(右侧自绘)
  platform: process.platform,
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
  storage: {
    getItem: (key) => ipcRenderer.sendSync('settings-storage:get', key),
    setItem: (key, value) => ipcRenderer.sendSync('settings-storage:set', key, value),
    removeItem: (key) => ipcRenderer.sendSync('settings-storage:remove', key),
  },
})
