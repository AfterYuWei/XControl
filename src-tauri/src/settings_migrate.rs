//! Electron settings.json → localStorage 一次性迁移（见迁移方案 §9.2）。
//!
//! Electron 的 userData/settings.json 结构为 `{"<key>": "<value JSON>"}`，
//! 其中 key 即 zustand persist 的 name（"xcontrol-settings"），值与 localStorage 同构。
//! 迁移 = 前端把返回值写入 localStorage 后再水化 zustand store。

use std::path::Path;

use crate::backend::user_data_dir;

/// 读取尚未迁移的设置。marker 存在或读取失败时返回 None。
/// marker 必须等前端成功写入 localStorage 后再由 [`mark_migrated`] 创建。
pub fn read_unmigrated() -> Option<serde_json::Value> {
    read_unmigrated_in(&user_data_dir().ok()?)
}

fn read_unmigrated_in(dir: &Path) -> Option<serde_json::Value> {
    let marker = dir.join(".tauri-migrated");
    if marker.exists() {
        return None;
    }
    let raw = std::fs::read_to_string(dir.join("settings.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 前端确认 localStorage 已写入（或已有更新设置）后创建迁移 marker。
pub fn mark_migrated() -> Result<(), String> {
    let dir = user_data_dir().map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    mark_migrated_in(&dir)
}

fn mark_migrated_in(dir: &Path) -> Result<(), String> {
    std::fs::write(dir.join(".tauri-migrated"), "").map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "xcontrol-migrate-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn marker_is_written_only_after_confirmation() {
        let dir = temp_dir("once");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"xcontrol-settings":"{\"state\":{}}"}"#,
        )
        .unwrap();

        let first = read_unmigrated_in(&dir).unwrap();
        assert!(first.get("xcontrol-settings").is_some());
        // 只读不会提前创建 marker，前端写入失败时下次仍可重试。
        assert!(read_unmigrated_in(&dir).is_some());
        mark_migrated_in(&dir).unwrap();
        assert!(read_unmigrated_in(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_returns_none() {
        let dir = temp_dir("missing");
        assert!(read_unmigrated_in(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
