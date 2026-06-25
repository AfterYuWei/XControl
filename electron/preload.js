const { contextBridge } = require('electron')

// 暴露一个最小标识给前端，便于前端在桌面环境下做差异化处理（如隐藏“浏览器打开”提示）
contextBridge.exposeInMainWorld('sshx', {
  desktop: true,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
})
