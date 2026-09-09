use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use super::PlatformError;

pub(crate) fn save_blob(
    app: &AppHandle,
    bytes: &[u8],
    suggested_name: &str,
) -> Result<Option<String>, PlatformError> {
    let temp_path = unique_temp_path();
    std::fs::write(&temp_path, bytes)
        .map_err(|error| PlatformError::io("写入临时文件失败", error))?;
    prompt_and_persist(app, &temp_path, suggested_name)
}

fn prompt_and_persist(
    app: &AppHandle,
    temp_path: &Path,
    suggested_name: &str,
) -> Result<Option<String>, PlatformError> {
    let mut dialog = app.dialog().file().set_file_name(suggested_name);
    if let Some(extension) = Path::new(suggested_name)
        .extension()
        .and_then(|extension| extension.to_str())
    {
        dialog = dialog.add_filter(format!("{extension} 文件"), &[extension]);
    }
    let Some(destination) = dialog.blocking_save_file() else {
        let _ = std::fs::remove_file(temp_path);
        return Ok(None);
    };
    let destination: PathBuf = destination
        .into_path()
        .map_err(|error| PlatformError::Dialog(error.to_string()))?;
    if std::fs::rename(temp_path, &destination).is_err() {
        std::fs::copy(temp_path, &destination)
            .map_err(|error| PlatformError::io("写入目标文件失败", error))?;
        let _ = std::fs::remove_file(temp_path);
    }
    Ok(Some(destination.display().to_string()))
}

fn unique_temp_path() -> PathBuf {
    let unique = format!(
        "xcontrol-save-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    );
    std::env::temp_dir().join(format!("{unique}.tmp"))
}
