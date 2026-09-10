import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { initDesktop } from '@/lib/desktop'
import { initializePlatform, isDesktopRuntime } from '@/lib/platform'
import { scheduleSilentUpdateCheck } from '@/lib/updater'
import { installFrontendLogging } from '@/lib/appLog'
import './index.css'
import '@xterm/xterm/css/xterm.css'

let appRoot: Root | null = null
let fatalRendered = false

// 引导时序：
// 1. initDesktop 必须先于一切 store 导入，保证 Electron 历史设置先于
//    zustand persist 水化完成迁移；浏览器下立即返回。
// 2. App 动态导入：静态 import 会在本模块求值时立即触发 store 模块初始化，
//    破坏上述顺序，因此必须放在 await 之后。
async function bootstrap() {
  try {
    await initializePlatform()
    await initDesktop()
    installFrontendLogging()
  } catch (err) {
    renderFatal(err instanceof Error ? err.message : String(err))
    // 主窗口初始为 visible:false，初始化失败时也必须主动显示错误页。
    if (isDesktopRuntime()) {
      await invoke('frontend_ready').catch(() => undefined)
    }
    return
  }
  if (fatalRendered) return

  const { default: App } = await import('./App.tsx')
  if (fatalRendered) return
  appRoot = createRoot(document.getElementById('root')!)
  appRoot.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )

  // 首帧渲染完成后显示并最大化窗口（等价 Electron ready-to-show + maximize）。
  // 注意窗口此时 visible:false，rAF 在隐藏窗口中可能被节流，故用 setTimeout。
  if (isDesktopRuntime()) {
    setTimeout(() => void invoke('frontend_ready'), 0)
    // 启动静默检查更新（延迟 10s，不抢启动带宽）
    scheduleSilentUpdateCheck()
  }
}

/** 初始化失败的兜底界面。 */
function renderFatal(message: string) {
  fatalRendered = true
  appRoot?.unmount()
  appRoot = null

  const root = document.getElementById('root')!
  const shell = document.createElement('div')
  shell.style.cssText = 'min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0A0A0A;color:#e5e5e5;font-family:system-ui,sans-serif;padding:24px;'
  const content = document.createElement('div')
  content.style.cssText = 'max-width:560px;'
  const title = document.createElement('h2')
  title.style.cssText = 'margin:0 0 12px;font-size:18px;'
  title.textContent = 'eizhu 运行失败'
  const detail = document.createElement('p')
  detail.style.cssText = 'margin:0 0 16px;color:#a3a3a3;font-size:13px;line-height:1.7;'
  detail.textContent = message
  const hint = document.createElement('p')
  hint.style.cssText = 'margin:0;color:#737373;font-size:12px;'
  hint.textContent = '可重新启动应用重试；若持续失败，请查看设置中的诊断日志。'
  content.append(title, detail, hint)
  shell.append(content)
  root.replaceChildren(shell)
}

void bootstrap()
