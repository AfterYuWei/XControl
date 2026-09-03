//! 前端 invoke 命令（桌面桥，见迁移方案 §5.5）。

use tauri::{AppHandle, Manager, State};

use crate::backend::{BackendInfo, BackendState};
use crate::settings_migrate;

/// 获取后端连接信息（端口 + 访问令牌）。阻塞直到后端就绪或超时（20s）。
///
/// 前端在 `main.tsx` 的 `initDesktop()` 中最先调用它，完成后再渲染应用，
/// 因此所有 API/WS 请求都能拿到确定的 base URL 与 token。
#[tauri::command]
pub async fn get_backend_info(state: State<'_, BackendState>) -> Result<BackendInfo, String> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        match state.get() {
            Some(Ok(info)) => return Ok(info),
            Some(Err(err)) => return Err(err),
            None => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("后端启动超时（20s），请查看用户数据目录 logs/backend.log".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

/// 前端首帧渲染完成：显示并最大化窗口（等价 Electron ready-to-show + maximize，方案 §5.2）。
#[tauri::command]
pub fn frontend_ready(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.maximize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 当前平台（"macos" | "windows" | "linux"）。
/// 注意与 Electron process.platform 的差异：darwin → macos（前端 isMac() 需同步调整）。
#[tauri::command]
pub fn get_platform() -> &'static str {
    std::env::consts::OS
}

/// 一次性读取 Electron 时代的 settings.json（UI 偏好迁移到 localStorage，方案 §9.2）。
/// 仅首次返回 Some，前端写入 localStorage 后 zustand persist 再水化。
#[tauri::command]
pub fn migrate_electron_settings() -> Option<serde_json::Value> {
    settings_migrate::read_and_mark()
}
