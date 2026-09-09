//! Desktop-only Tauri command adapters.

use std::{
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::settings_migrate;

/// 前端首帧渲染完成：显示并最大化窗口（等价 Electron ready-to-show + maximize）。
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

// ─── 测试版日志 ───────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
pub struct AppLogSnapshot {
    pub kind: String,
    pub path: String,
    pub content: String,
}

fn app_log_path(kind: &str) -> Result<PathBuf, String> {
    if !crate::runtime::is_test_build() {
        return Err("日志查看器仅在测试版本中启用".into());
    }
    let filename = match kind {
        "frontend" => "frontend.log",
        "backend" => "backend.log",
        _ => return Err("未知日志类型".into()),
    };
    let dir = crate::runtime::user_data_dir()
        .map_err(|err| err.to_string())?
        .join("logs");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join(filename))
}

/// 读取日志尾部，限制 2 MiB，避免长时间运行后一次 IPC 占用过多内存。
#[tauri::command]
pub fn read_app_log(kind: String) -> Result<AppLogSnapshot, String> {
    const MAX_BYTES: u64 = 2 * 1024 * 1024;
    let path = app_log_path(&kind)?;
    if !path.exists() {
        std::fs::write(&path, b"").map_err(|err| err.to_string())?;
    }
    let mut file = std::fs::File::open(&path).map_err(|err| err.to_string())?;
    let len = file.metadata().map_err(|err| err.to_string())?.len();
    let start = len.saturating_sub(MAX_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|err| err.to_string())?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes)
        .map_err(|err| err.to_string())?;
    if start > 0 {
        if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.drain(..=newline);
        }
    }
    Ok(AppLogSnapshot {
        kind,
        path: path.display().to_string(),
        content: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// 前端批量落盘。限制单批数量和单行大小，防止错误对象造成日志洪泛。
#[tauri::command]
pub fn append_frontend_log(lines: Vec<String>) -> Result<(), String> {
    let path = app_log_path("frontend")?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| err.to_string())?;
    for line in lines.into_iter().take(512) {
        let safe_line = line.chars().take(16 * 1024).collect::<String>();
        writeln!(file, "{safe_line}").map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn clear_app_log(kind: String) -> Result<(), String> {
    let path = app_log_path(&kind)?;
    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|err| err.to_string())?;
    Ok(())
}

/// 一次性读取 Electron 时代的 settings.json（UI 偏好迁移到 localStorage）。
/// 仅首次返回 Some，前端写入 localStorage 后 zustand persist 再水化。
#[tauri::command]
pub fn migrate_electron_settings() -> Option<serde_json::Value> {
    settings_migrate::read_unmigrated()
}

/// 前端成功保存迁移设置后确认完成；确认前不会创建 marker，失败可在下次启动重试。
#[tauri::command]
pub fn mark_electron_settings_migrated() -> Result<(), String> {
    settings_migrate::mark_migrated()
}

// ─── 磁盘保存 ───────────────────────────────────────────────────────────────
// WKWebView/WebKitGTK 下 blob + <a download> 不可靠，桌面端统一切换为
// Rust 侧「系统保存对话框 + 文件落盘」。文件内容不经过 IPC payload（大文件友好）。

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
