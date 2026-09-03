//! Electron settings.json → localStorage 一次性迁移（见迁移方案 §9.2）。
//!
//! Electron 的 userData/settings.json 结构为 `{"<key>": "<value JSON>"}`，
//! 其中 key 即 zustand persist 的 name（"xcontrol-settings"），值与 localStorage 同构。
//! 迁移 = 前端把返回值写入 localStorage 后再水化 zustand store。

use std::path::Path;

use crate::backend::user_data_dir;

/// 读取并标记。仅首次成功返回 Some；marker 存在或读取失败时返回 None。
pub fn read_and_mark() -> Option<serde_json::Value> {
    read_and_mark_in(&user_data_dir().ok()?)
}

fn read_and_mark_in(dir: &Path) -> Option<serde_json::Value> {
    let marker = dir.join(".tauri-migrated");
    if marker.exists() {
        return None;
    }
    let raw = std::fs::read_to_string(dir.join("settings.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let _ = std::fs::write(&marker, "");
    Some(value)
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
    fn returns_settings_only_once() {
        let dir = temp_dir("once");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"xcontrol-settings":"{\"state\":{}}"}"#,
        )
        .unwrap();

        let first = read_and_mark_in(&dir).unwrap();
        assert!(first.get("xcontrol-settings").is_some());
        // marker 已写入，二次调用不再返回
        assert!(read_and_mark_in(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_returns_none() {
        let dir = temp_dir("missing");
        assert!(read_and_mark_in(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
