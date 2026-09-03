//! SFTP 拖出到系统：远程文件物化到临时目录（移植自 Electron materializeRemoteDrag，
//! 见迁移方案 §6.6 拖出部分）。
//!
//! 流程：同名检测 → 创建 xcontrol-drag-* 临时目录 → POST /api/sftp/transfer
//! （远程会话 → 本机会话，overwrite + preserve）→ 轮询任务完成 → 校验文件落盘
//! → 返回本机路径列表 + 拖拽预览图标路径。临时目录 1 小时后清理；
//! 启动时清扫 24 小时以上的残留目录（对应 Electron 的 sweepNativeDragTemps）。

use std::{
    path::Path,
    time::{Duration, SystemTime},
};

use serde::Serialize;

use crate::{backend, http};

/// 拖出临时目录前缀（与 Electron 保持一致，便于清扫历史残留）。
const DRAG_TEMP_PREFIX: &str = "xcontrol-drag-";
/// 拖拽预览图标（编译期内嵌，避免依赖打包后的资源文件）。
const DRAG_ICON_PNG: &[u8] = include_bytes!("../app-icon.png");

#[derive(Serialize)]
pub struct DragOutFiles {
    /// 物化后的本机文件绝对路径（native 格式，直接喂给 drag 插件）。
    pub files: Vec<String>,
    /// 原生拖拽的预览图标路径。
    pub icon: String,
}

/// 前端命令入口：物化远程文件，返回本机路径 + 图标路径。
#[tauri::command]
pub async fn sftp_drag_out(
    source_session_id: String,
    local_session_id: String,
    paths: Vec<String>,
) -> Result<DragOutFiles, String> {
    tauri::async_runtime::spawn_blocking(move || {
        drag_out_blocking(&source_session_id, &local_session_id, &paths)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn drag_out_blocking(source: &str, local: &str, paths: &[String]) -> Result<DragOutFiles, String> {
    if paths.is_empty() {
        return Err("未选择要拖出的文件".into());
    }
    let info = backend::current_info().ok_or_else(|| "后端尚未就绪".to_string())?;

    // 1. 同名检测（Windows 大小写不敏感），对齐 Electron 行为
    let names: Vec<String> = paths.iter().map(|p| api_basename(p).to_string()).collect();
    let duplicated = if cfg!(windows) {
        let mut seen = std::collections::HashSet::new();
        names.iter().any(|name| !seen.insert(name.to_lowercase()))
    } else {
        let mut seen = std::collections::HashSet::new();
        names.iter().any(|name| !seen.insert(name.clone()))
    };
    if duplicated {
        return Err("所选项目包含同名文件，暂时无法同时拖出".into());
    }

    // 2. 临时目录 + 拖拽预览图标
    let temp_dir = std::env::temp_dir().join(format!("{DRAG_TEMP_PREFIX}{}", unique_suffix()));
    std::fs::create_dir_all(&temp_dir).map_err(|err| format!("创建临时目录失败: {err}"))?;
    let icon_path = temp_dir.join(".drag-icon.png");
    std::fs::write(&icon_path, DRAG_ICON_PNG).map_err(|err| format!("写入图标失败: {err}"))?;

    // 3. 发起跨会话传输（远程 → 本机临时目录）
    let body = serde_json::json!({
        "source_session_id": source,
        "target_session_id": local,
        "paths": paths,
        "dest_dir": native_to_api(&temp_dir),
        "conflict_resolution": "overwrite",
        "directory_mode": "preserve",
    });
    let response = http::request(
        info.port,
        "POST",
        "/api/sftp/transfer",
        Some(&info.token),
        None,
        Some(body.to_string().as_bytes()),
    )
    .map_err(|err| format!("无法准备拖出文件: {err}"))?;
    if response.status != 202 {
        return Err(extract_error_message(&response, "无法准备拖出文件"));
    }
    let task_id: String = serde_json::from_slice::<serde_json::Value>(&response.body)
        .ok()
        .and_then(|value| {
            value
                .get("task_id")
                .and_then(|task_id| task_id.as_str())
                .map(String::from)
        })
        .ok_or_else(|| "后端未返回任务 ID".to_string())?;

    // 4. 轮询任务状态（250ms × 10 分钟，对齐 Electron）
    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    loop {
        if let Ok(list) = http::request(
            info.port,
            "GET",
            "/api/sftp/transfers",
            Some(&info.token),
            None,
            None,
        ) {
            if let Some(task) = find_task(&list.body, &task_id) {
                let status = task.get("status").and_then(|s| s.as_str()).unwrap_or("");
                match status {
                    "completed" => break,
                    "failed" | "cancelled" => {
                        let message = task
                            .get("error_message")
                            .and_then(|m| m.as_str())
                            .unwrap_or(if status == "failed" {
                                "传输失败"
                            } else {
                                "已取消"
                            });
                        schedule_cleanup(&temp_dir);
                        return Err(format!("准备拖出文件失败: {message}"));
                    }
                    _ => {}
                }
            }
        }
        if std::time::Instant::now() > deadline {
            schedule_cleanup(&temp_dir);
            return Err("准备拖出文件超时".into());
        }
        std::thread::sleep(Duration::from_millis(250));
    }

    // 5. 校验物化结果
    let mut files = Vec::with_capacity(names.len());
    for name in &names {
        let path = temp_dir.join(name);
        if !path.exists() {
            schedule_cleanup(&temp_dir);
            return Err("拖出文件准备不完整".into());
        }
        files.push(path.to_string_lossy().into_owned());
    }

    // 6. 1 小时后清理临时目录（对齐 Electron removeNativeDragTemp 延迟）
    schedule_cleanup(&temp_dir);

    Ok(DragOutFiles {
        files,
        icon: icon_path.to_string_lossy().into_owned(),
    })
}

/// 启动时清扫 24 小时以上的拖出临时目录（对应 Electron sweepNativeDragTemps）。
pub fn sweep_stale_drag_temps() {
    let temp_root = match std::env::temp_dir().read_dir() {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let now = SystemTime::now();
    for entry in temp_root.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(DRAG_TEMP_PREFIX) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > Duration::from_secs(24 * 60 * 60));
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// 在传输任务数组中查找指定任务（/api/sftp/transfers 返回裸数组）。
fn find_task(body: &[u8], task_id: &str) -> Option<serde_json::Value> {
    let tasks: Vec<serde_json::Value> = serde_json::from_slice(body).ok()?;
    tasks
        .into_iter()
        .find(|task| task.get("id").and_then(|id| id.as_str()) == Some(task_id))
}

/// 从后端错误响应中提取 error.message（兼容非 JSON 响应）。
fn extract_error_message(response: &http::HttpResponse, fallback: &str) -> String {
    serde_json::from_slice::<serde_json::Value>(&response.body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(|message| message.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| fallback.to_string())
}

/// API 路径（POSIX 风格）取最后一段作为文件名。
fn api_basename(path: &str) -> &str {
    path.rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(path)
}

/// 本机路径 → 后端 API 路径（Windows 盘符前加 /，对齐 Electron nativePathToAPI）。
fn native_to_api(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) && normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        format!("/{normalized}")
    } else {
        normalized
    }
}

fn unique_suffix() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    )
}

/// 1 小时后删除临时目录（后台线程，进程退出则放弃——启动清扫兜底）。
fn schedule_cleanup(temp_dir: &Path) {
    let temp_dir = temp_dir.to_path_buf();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60 * 60));
        let _ = std::fs::remove_dir_all(temp_dir);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn api_basename_works() {
        assert_eq!(api_basename("/root/logs/access.log"), "access.log");
        assert_eq!(api_basename("/C:/Users/foo.txt"), "foo.txt");
        assert_eq!(api_basename("plain"), "plain");
    }

    #[test]
    fn native_to_api_matches_electron_semantics() {
        // unix 下恒等
        #[cfg(unix)]
        {
            let path = PathBuf::from("/tmp/xcontrol-drag-1");
            assert_eq!(native_to_api(&path), "/tmp/xcontrol-drag-1");
        }
        // Windows 盘符语义用字符串级断言（跨平台可测）
        assert!(native_to_api(&PathBuf::from(if cfg!(windows) {
            "C:\\Temp\\f"
        } else {
            "/tmp/f"
        }))
        .starts_with('/'));
    }

    #[test]
    fn find_task_parses_transfer_list() {
        let body = br#"[{"id":"t1","status":"transferring"},{"id":"t2","status":"completed"}]"#;
        let task = find_task(body, "t2").unwrap();
        assert_eq!(task.get("status").unwrap().as_str(), Some("completed"));
        assert!(find_task(body, "t3").is_none());
    }
}
