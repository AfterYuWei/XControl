import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { initDesktop, isTauri } from '@/lib/desktop'
import { scheduleSilentUpdateCheck } from '@/lib/updater'
import './index.css'
import '@xterm/xterm/css/xterm.css'

interface BackendExitedPayload {
  message: string
}

let appRoot: Root | null = null
let fatalRendered = false

// 引导时序（docs/TAURI_MIGRATION.md §6.2）：
// 1. initDesktop 必须先于一切 store 导入 —— Tauri 下获取后端端口/令牌并完成
//    Electron 设置迁移，保证 zustand persist 水化发生在迁移之后、API/WS 请求
//    带上确定的 base URL 与鉴权头；浏览器下立即返回，零开销。
// 2. App 动态导入：静态 import 会在本模块求值时立即触发 store 模块初始化，
//    破坏上述顺序，因此必须放在 await 之后。
async function bootstrap() {
  if (isTauri()) {
    // 先于 get_backend_info 注册，避免 sidecar 在刚完成健康检查后退出时漏掉事件。
    await listen<BackendExitedPayload>('backend-exited', (event) => {
      renderFatal(event.payload.message || '后端进程意外退出')
      void invoke('frontend_ready').catch(() => undefined)
    }).catch(() => undefined)
  }

  try {
    await initDesktop()
  } catch (err) {
    renderFatal(err instanceof Error ? err.message : String(err))
    // 主窗口初始为 visible:false。后端启动失败时也必须主动显示窗口，
    // 否则用户只能看到进程存在，却看不到上面的诊断信息。
    if (isTauri()) {
      await invoke('frontend_ready').catch(() => undefined)
    }
    return
  }
  if (fatalRendered) return

  const { default: App } = await import('./App.tsx')
  // 动态加载 App 期间 sidecar 仍可能退出；不要让随后创建的 React 根节点
  // 覆盖 backend-exited 事件已经渲染出的致命错误页。
  if (fatalRendered) return
  appRoot = createRoot(document.getElementById('root')!)
  appRoot.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )

  // 首帧渲染完成后显示并最大化窗口（等价 Electron ready-to-show + maximize）。
  // 注意窗口此时 visible:false，rAF 在隐藏窗口中可能被节流，故用 setTimeout。
  if (isTauri()) {
    setTimeout(() => void invoke('frontend_ready'), 0)
    // 启动静默检查更新（延迟 10s，不抢启动带宽）
    scheduleSilentUpdateCheck()
  }
}

/** 后端启动失败等致命错误的兜底界面（对齐 Electron dialog.showErrorBox）。 */
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
  title.textContent = 'XControl 运行失败'
  const detail = document.createElement('p')
  detail.style.cssText = 'margin:0 0 16px;color:#a3a3a3;font-size:13px;line-height:1.7;'
  detail.textContent = message
  const hint = document.createElement('p')
  hint.style.cssText = 'margin:0;color:#737373;font-size:12px;'
  hint.textContent = '可重新启动应用重试；若持续失败，请检查用户数据目录 logs/backend.log。'
  content.append(title, detail, hint)
  shell.append(content)
  root.replaceChildren(shell)
}

void bootstrap()
