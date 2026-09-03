//! 前端 invoke 命令（桌面桥，见迁移方案 §5.5）。

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

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

// ─── 磁盘保存（方案 §5.5 / §6） ─────────────────────────────────────────────
// WKWebView/WebKitGTK 下 blob + <a download> 不可靠，桌面端统一切换为
// Rust 侧「系统保存对话框 + 文件落盘」。文件内容不经过 IPC payload（大文件友好）。

/// 将后端 API 响应保存到用户选择的文件（备份导出等）。
/// 大文件不进 IPC：Rust 直接从 sidecar 拉取（Bearer）→ temp → 对话框 → 移动。
/// 返回 Ok(Some(最终路径)) 已保存；Ok(None) 用户取消；Err 含后端错误信息。
///
/// 注：当前 http 客户端整包读入内存，适用于备份导出等中小文件；
/// 后续接入大文件下载（SFTP）时可扩展为流式写盘。
#[tauri::command]
pub async fn save_url_to_disk(
    app: AppHandle,
    api_path: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let info = crate::backend::current_info().ok_or_else(|| "后端尚未就绪".to_string())?;
        let response =
            crate::http::request(info.port, "GET", &api_path, Some(&info.token), None, None)
                .map_err(|err| format!("请求后端失败: {err}"))?;
        if response.status != 200 {
            let message = serde_json::from_slice::<serde_json::Value>(&response.body)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/error/message")
                        .and_then(|message| message.as_str())
                        .map(String::from)
                })
                .unwrap_or_else(|| format!("后端返回状态码 {}", response.status));
            return Err(message);
        }
        let temp_path = unique_temp_path();
        std::fs::write(&temp_path, &response.body)
            .map_err(|err| format!("写入临时文件失败: {err}"))?;
        prompt_and_persist(&app, &temp_path, &suggested_name)
    })
    .await
    .map_err(|err| err.to_string())?
}

/// 将前端生成的小段内容（如私钥文本）保存到用户选择的文件。
#[tauri::command]
pub async fn save_blob_to_disk(
    app: AppHandle,
    bytes: Vec<u8>,
    suggested_name: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let temp_path = unique_temp_path();
        std::fs::write(&temp_path, &bytes).map_err(|err| format!("写入临时文件失败: {err}"))?;
        prompt_and_persist(&app, &temp_path, &suggested_name)
    })
    .await
    .map_err(|err| err.to_string())?
}

/// 保存对话框 + temp 落盘的公共流程。必须在非主线程调用（blocking_save_file）。
fn prompt_and_persist(
    app: &AppHandle,
    temp_path: &Path,
    suggested_name: &str,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_file_name(suggested_name);
    if let Some(ext) = Path::new(suggested_name)
        .extension()
        .and_then(|e| e.to_str())
    {
        dialog = dialog.add_filter(format!("{ext} 文件"), &[ext]);
    }
    let Some(dest) = dialog.blocking_save_file() else {
        let _ = std::fs::remove_file(temp_path);
        return Ok(None); // 用户取消
    };
    let dest: PathBuf = dest.into_path().map_err(|err| err.to_string())?;

    // rename 优先（同盘零拷贝），跨设备回退 copy+delete
    if std::fs::rename(temp_path, &dest).is_err() {
        std::fs::copy(temp_path, &dest).map_err(|err| format!("写入目标文件失败: {err}"))?;
        let _ = std::fs::remove_file(temp_path);
    }
    Ok(Some(dest.display().to_string()))
}

fn unique_temp_path() -> PathBuf {
    let unique = format!(
        "xcontrol-save-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    );
    std::env::temp_dir().join(format!("{unique}.tmp"))
}
