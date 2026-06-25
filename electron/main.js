const { app, BrowserWindow, shell, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const http = require('http')
const net = require('net')

let backendProcess = null
let mainWindow = null
let backendPort = 0

// 后端可执行文件路径：打包后在 resources 目录，开发时取 server 目录
function getBackendExecutable() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'sshx-server', 'sshx-server.exe')
  }
  return (
    process.env.SSHX_SERVER_PATH ||
    path.join(__dirname, '..', 'server', 'sshx-server.exe')
  )
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

function startBackend(port) {
  const exe = getBackendExecutable()
  const userData = app.getPath('userData')
  const logsDir = path.join(userData, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const logFile = path.join(logsDir, 'backend.log')
  const out = fs.openSync(logFile, 'a')
  const err = fs.openSync(logFile, 'a')

  // 数据库与密钥存放在用户数据目录，避免写入只读的 resources 目录
  const env = Object.assign({}, process.env, {
    SSHX_PORT: String(port),
    SSHX_DB_PATH: path.join(userData, 'sshx.db'),
    SSHX_KEY_PATH: path.join(userData, 'key'),
    SSHX_LOG_LEVEL: 'info',
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
}

// 轮询后端健康检查接口，直到就绪或超时
function waitForBackend(port, timeoutMs = 15000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/groups`, (res) => {
        res.resume()
        if (res.statusCode < 500) resolve()
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

function killBackend() {
  if (!backendProcess) return
  try {
    if (process.platform === 'win32') {
      // Windows 下强制结束整个进程树，避免孤儿进程
      spawn('taskkill', ['/F', '/T', '/PID', String(backendProcess.pid)], {
        windowsHide: true,
      })
    } else {
      backendProcess.kill('SIGTERM')
    }
  } catch (e) {
    console.error('kill backend failed', e)
  }
  backendProcess = null
}

async function createWindow() {
  backendPort = await pickFreePort()
  startBackend(backendPort)
  try {
    await waitForBackend(backendPort)
  } catch (e) {
    console.error(e.message)
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'SSHX',
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.loadURL(`http://127.0.0.1:${backendPort}/`)

  // 外部链接在系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

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
    createWindow()
  })

  app.on('window-all-closed', () => {
    killBackend()
    app.quit()
  })

  app.on('before-quit', killBackend)
  process.on('exit', killBackend)
}
