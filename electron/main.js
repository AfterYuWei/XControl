const { app, BrowserWindow, shell, Menu, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawn } = require('child_process')
const http = require('http')
const net = require('net')

let backendProcess = null
let mainWindow = null
let backendPort = 0
let backendToken = ''
let backendStopping = false
const isSmokeTest = process.argv.includes('--smoke-test')

function getSettingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function readSettingsStore() {
  const file = getSettingsFilePath()
  try {
    if (!fs.existsSync(file)) return {}
    const raw = fs.readFileSync(file, 'utf8')
    if (!raw.trim()) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    console.error('read settings store failed', error)
    return {}
  }
}

function writeSettingsStore(store) {
  const file = getSettingsFilePath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8')
    return true
  } catch (error) {
    console.error('write settings store failed', error)
    return false
  }
}

// 后端可执行文件路径：打包后在 resources 目录，开发时取 server 目录。
// 跨平台后端文件名：Windows 为 xcontrol-server.exe，macOS/Linux 为 xcontrol-server（无后缀）。
function getBackendExecutable() {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const name = `xcontrol-server${ext}`
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'xcontrol-server', name)
  }
  return process.env.XCONTROL_SERVER_PATH || path.join(__dirname, '..', 'server', name)
}

// 申请一个空闲端口，避免与其它占用 9090 的服务冲突
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

function startBackend(port, token) {
  const exe = getBackendExecutable()
  const userData = app.getPath('userData')
  const logsDir = path.join(userData, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const logFile = path.join(logsDir, 'backend.log')
  const out = fs.openSync(logFile, 'a')
  const err = fs.openSync(logFile, 'a')

  // 数据库与密钥存放在用户数据目录，避免写入只读的 resources 目录
  const env = Object.assign({}, process.env, {
    XCONTROL_PORT: String(port),
    XCONTROL_HOST: '127.0.0.1',
    XCONTROL_DB_PATH: path.join(userData, 'xcontrol.db'),
    XCONTROL_KEY_PATH: path.join(userData, 'key'),
    XCONTROL_LOG_LEVEL: 'info',
    XCONTROL_ACCESS_TOKEN: token,
  })

  backendProcess = spawn(exe, [], {
    env,
    stdio: ['ignore', out, err],
    windowsHide: true,
  })

  backendProcess.on('exit', (code, signal) => {
    console.log(`backend exited code=${code} signal=${signal}`)
    backendProcess = null
  })
  backendProcess.on('error', (error) => {
    console.error('backend process failed', error)
  })
}

// 轮询后端健康检查接口，直到就绪或超时
function waitForBackend(port, timeoutMs = 15000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume()
        if (res.statusCode === 204) resolve()
        else retry()
      })
      req.on('error', retry)
      function retry() {
        if (Date.now() - start > timeoutMs) {
          reject(new Error('后端启动超时，请查看日志：' + path.join(app.getPath('userData'), 'logs', 'backend.log')))
        } else {
          setTimeout(check, 200)
        }
      }
    }
    check()
  })
}

function forceKillBackend(processToKill = backendProcess) {
  if (!processToKill) return
  try {
    if (process.platform === 'win32') {
      // Windows 下强制结束整个进程树，避免孤儿进程
      spawn('taskkill', ['/F', '/T', '/PID', String(processToKill.pid)], {
        windowsHide: true,
      })
    } else {
      processToKill.kill('SIGKILL')
    }
  } catch (e) {
    console.error('kill backend failed', e)
  }
  if (backendProcess === processToKill) backendProcess = null
}

function requestBackendShutdown() {
  return new Promise((resolve) => {
    if (!backendPort || !backendToken) {
      resolve(false)
      return
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port: backendPort,
      path: '/api/shutdown',
      method: 'POST',
      headers: { Authorization: `Bearer ${backendToken}` },
      timeout: 1500,
    }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode === 202))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
    req.end()
  })
}

function waitForProcessExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

async function stopBackend() {
  if (!backendProcess || backendStopping) return
  backendStopping = true
  const child = backendProcess
  await requestBackendShutdown()
  const exited = await waitForProcessExit(child, 5000)
  if (!exited) forceKillBackend(child)
  if (backendProcess === child) backendProcess = null
  backendStopping = false
}

async function createWindow() {
  backendPort = await pickFreePort()
  backendToken = crypto.randomBytes(32).toString('base64url')
  startBackend(backendPort, backendToken)
  await waitForBackend(backendPort)

  // 跨平台窗口配置：
  // - macOS: titleBarStyle 'hiddenInset' 保留原生交通灯（左侧红黄绿圆形按钮），
  //   隐藏标题栏文字，内容左移给交通灯留空间。交互完全原生（hover 符号、双击最大化等）。
  // - Windows/Linux: frame:false 移除系统标题栏，由前端自绘右侧控制按钮。
  //   frame:false 在 Windows 上仍保留边缘拖拽缩放能力。
  const isMac = process.platform === 'darwin'
  const windowOptions = {
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'XControl',
    backgroundColor: '#0A0A0A',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  }
  if (isMac) {
    windowOptions.titleBarStyle = 'hiddenInset'
    // trafficLightPosition 可选：将交通灯下移与自定义标题栏对齐
    windowOptions.trafficLightPosition = { x: 12, y: 13 }
  } else {
    windowOptions.frame = false
  }

  mainWindow = new BrowserWindow(windowOptions)

  if (!isSmokeTest) {
    mainWindow.once('ready-to-show', () => {
      mainWindow.maximize()
      mainWindow.show()
    })
  }
  const backendURL = `http://127.0.0.1:${backendPort}`
  await mainWindow.webContents.session.cookies.set({
    url: backendURL,
    name: 'xcontrol_access_token',
    value: backendToken,
    httpOnly: true,
    secure: false,
    sameSite: 'strict',
  })
  await mainWindow.loadURL(`${backendURL}/`)
  if (isSmokeTest) {
    const result = await mainWindow.webContents.executeJavaScript(`
      Promise.all([
        fetch('/api/groups').then((response) => response.status),
        Promise.resolve(document.cookie.includes('xcontrol_access_token')),
      ])
    `)
    if (result[0] !== 200 || result[1] !== false) {
      throw new Error(`desktop smoke check failed: ${JSON.stringify(result)}`)
    }
    console.log('XCONTROL_ELECTRON_SMOKE_OK')
    setTimeout(() => app.quit(), 50)
  }

  // 外部链接在系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 窗口最大化/还原状态变化时，主动推送给渲染进程，
  // 使标题栏按钮图标能同步系统快捷键(Win+↑/↓)与边缘拖拽触发的最大化。
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized', false)
  })
}

// 窗口控制 IPC：渲染层通过 preload 暴露的安全 API 调用，由主进程执行真实窗口操作。
// 所有 handler 都用 lazy 注册 + main 窗口校验，避免窗口关闭后空指针。
function win() {
  return mainWindow
}
ipcMain.handle('window:minimize', () => win()?.minimize())
ipcMain.handle('window:maximizeToggle', () => {
  const w = win()
  if (!w) return false
  if (w.isMaximized()) w.unmaximize()
  else w.maximize()
  return w.isMaximized()
})
ipcMain.handle('window:close', () => win()?.close())
ipcMain.handle('window:isMaximized', () => (win() ? win().isMaximized() : false))

ipcMain.on('settings-storage:get', (event, key) => {
  const store = readSettingsStore()
  event.returnValue = Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null
})

ipcMain.on('settings-storage:set', (event, key, value) => {
  const store = readSettingsStore()
  store[key] = value
  event.returnValue = writeSettingsStore(store)
})

ipcMain.on('settings-storage:remove', (event, key) => {
  const store = readSettingsStore()
  delete store[key]
  event.returnValue = writeSettingsStore(store)
})

// 单实例锁，避免重复启动导致后端端口抢占
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    // 隐藏默认菜单栏（可按需注释保留）
    Menu.setApplicationMenu(null)
    createWindow().catch((error) => {
      console.error(error)
      process.exitCode = 1
      if (!isSmokeTest) {
        dialog.showErrorBox('XControl 启动失败', error.message || String(error))
      }
      app.quit()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (!backendProcess || backendStopping) return
    event.preventDefault()
    void stopBackend().finally(() => app.quit())
  })
  process.on('exit', () => forceKillBackend())
}
