//! SFTP 拖出到系统：远程文件物化到临时目录（移植自 Electron materializeRemoteDrag）。
//!
//! 流程：同名检测 → 创建 eizhu-drag-* 临时目录 → Rust 进程内物化远程内容 → 校验文件落盘
//! → 返回本机路径列表 + 拖拽预览图标路径。临时目录 1 小时后清理；
//! 启动时清扫 24 小时以上的残留目录（对应 Electron 的 sweepNativeDragTemps）。

use std::{
    path::Path,
    time::{Duration, SystemTime},
};

use serde::Serialize;

use crate::sftp::SftpService;

use super::PlatformError;

/// 拖出临时目录前缀（与 Electron 保持一致，便于清扫历史残留）。
const DRAG_TEMP_PREFIX: &str = "eizhu-drag-";
/// 拖拽预览图标（编译期内嵌，避免依赖打包后的资源文件）。
const DRAG_ICON_PNG: &[u8] = include_bytes!("../../../../app-icon.png");

#[derive(Serialize)]
pub(crate) struct DragOutFiles {
    /// 物化后的本机文件绝对路径（native 格式，直接喂给 drag 插件）。
    files: Vec<String>,
    /// 原生拖拽的预览图标路径。
    icon: String,
}

/// 前端命令入口：物化远程文件，返回本机路径 + 图标路径。
pub(crate) async fn materialize_drag(
    service: &SftpService,
    source_session_id: String,
    _local_session_id: String,
    paths: Vec<String>,
) -> Result<DragOutFiles, PlatformError> {
    if paths.is_empty() {
        return Err(PlatformError::InvalidInput("未选择要拖出的文件"));
    }

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
        return Err(PlatformError::InvalidInput(
            "所选项目包含同名文件，暂时无法同时拖出",
        ));
    }

    // 2. 临时目录 + 拖拽预览图标
    let temp_dir = std::env::temp_dir().join(format!("{DRAG_TEMP_PREFIX}{}", unique_suffix()));
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|error| PlatformError::io("创建临时目录失败", error))?;
    let icon_path = temp_dir.join(".drag-icon.png");
    tokio::fs::write(&icon_path, DRAG_ICON_PNG)
        .await
        .map_err(|error| PlatformError::io("写入图标失败", error))?;

    // 3. Rust 进程内直接把 SFTP 内容物化到临时目录。
    if let Err(error) = service
        .materialize_paths(&source_session_id, &paths, &native_to_api(&temp_dir))
        .await
    {
        schedule_cleanup(&temp_dir);
        return Err(PlatformError::Preparation(format!(
            "无法准备拖出文件: {}",
            error.message
        )));
    }

    // 4. 校验物化结果
    let mut files = Vec::with_capacity(names.len());
    for name in &names {
        let path = temp_dir.join(name);
        if !path.exists() {
            schedule_cleanup(&temp_dir);
            return Err(PlatformError::Preparation("拖出文件准备不完整".into()));
        }
        files.push(path.to_string_lossy().into_owned());
    }

    // 5. 1 小时后清理临时目录（对齐 Electron removeNativeDragTemp 延迟）
    schedule_cleanup(&temp_dir);

    Ok(DragOutFiles {
        files,
        icon: icon_path.to_string_lossy().into_owned(),
    })
}

/// 启动时清扫 24 小时以上的拖出临时目录（对应 Electron sweepNativeDragTemps）。
pub(crate) fn sweep_stale_drag_temps() {
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

/// 1 小时后删除临时目录（Tokio 定时任务，进程退出则放弃——启动清扫兜底）。
fn schedule_cleanup(temp_dir: &Path) {
    let temp_dir = temp_dir.to_path_buf();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60 * 60)).await;
        let _ = tokio::fs::remove_dir_all(temp_dir).await;
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
            let path = PathBuf::from("/tmp/eizhu-drag-1");
            assert_eq!(native_to_api(&path), "/tmp/eizhu-drag-1");
        }
        // Windows 盘符语义用字符串级断言（跨平台可测）
        assert!(native_to_api(&PathBuf::from(if cfg!(windows) {
            "C:\\Temp\\f"
        } else {
            "/tmp/f"
        }))
        .starts_with('/'));
    }
}
