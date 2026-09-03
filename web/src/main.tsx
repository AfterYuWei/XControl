import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { initDesktop, isTauri } from '@/lib/desktop'
import { scheduleSilentUpdateCheck } from '@/lib/updater'
import './index.css'
import '@xterm/xterm/css/xterm.css'

// 引导时序（docs/TAURI_MIGRATION.md §6.2）：
// 1. initDesktop 必须先于一切 store 导入 —— Tauri 下获取后端端口/令牌并完成
//    Electron 设置迁移，保证 zustand persist 水化发生在迁移之后、API/WS 请求
//    带上确定的 base URL 与鉴权头；浏览器下立即返回，零开销。
// 2. App 动态导入：静态 import 会在本模块求值时立即触发 store 模块初始化，
//    破坏上述顺序，因此必须放在 await 之后。
async function bootstrap() {
  try {
    await initDesktop()
  } catch (err) {
    renderFatal(err instanceof Error ? err.message : String(err))
    return
  }

  const { default: App } = await import('./App.tsx')
  createRoot(document.getElementById('root')!).render(
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
  document.getElementById('root')!.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0A0A0A;color:#e5e5e5;font-family:system-ui,sans-serif;padding:24px;">
      <div style="max-width:560px;">
        <h2 style="margin:0 0 12px;font-size:18px;">XControl 启动失败</h2>
        <p style="margin:0 0 16px;color:#a3a3a3;font-size:13px;line-height:1.7;">${message}</p>
        <p style="margin:0;color:#737373;font-size:12px;">可重新启动应用重试；若持续失败，请检查用户数据目录 logs/backend.log。</p>
      </div>
    </div>`
}

void bootstrap()
