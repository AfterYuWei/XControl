use std::io::{Read, Seek, SeekFrom, Write};

use serde::Serialize;

use super::{is_test_build, user_data_dir, PlatformError};

#[derive(Clone, Serialize)]
pub(crate) struct AppLogSnapshot {
    pub(crate) kind: String,
    pub(crate) path: String,
    pub(crate) content: String,
}

fn app_log_path(kind: &str) -> Result<std::path::PathBuf, PlatformError> {
    if !is_test_build() {
        return Err(PlatformError::Unavailable("日志查看器仅在测试版本中启用"));
    }
    let filename = match kind {
        "frontend" => "frontend.log",
        "backend" => "backend.log",
        _ => return Err(PlatformError::InvalidInput("未知日志类型")),
    };
    let directory = user_data_dir()?.join("logs");
    std::fs::create_dir_all(&directory)
        .map_err(|error| PlatformError::io("创建日志目录失败", error))?;
    Ok(directory.join(filename))
}

pub(crate) fn read_app_log(kind: String) -> Result<AppLogSnapshot, PlatformError> {
    const MAX_BYTES: u64 = 2 * 1024 * 1024;
    let path = app_log_path(&kind)?;
    if !path.exists() {
        std::fs::write(&path, b"").map_err(|error| PlatformError::io("创建日志失败", error))?;
    }
    let mut file =
        std::fs::File::open(&path).map_err(|error| PlatformError::io("打开日志失败", error))?;
    let length = file
        .metadata()
        .map_err(|error| PlatformError::io("读取日志信息失败", error))?
        .len();
    let start = length.saturating_sub(MAX_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| PlatformError::io("定位日志失败", error))?;
    let mut bytes = Vec::with_capacity((length - start) as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| PlatformError::io("读取日志失败", error))?;
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

pub(crate) fn append_frontend_log(lines: Vec<String>) -> Result<(), PlatformError> {
    let path = app_log_path("frontend")?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| PlatformError::io("打开前端日志失败", error))?;
    for line in lines.into_iter().take(512) {
        let safe_line = line.chars().take(16 * 1024).collect::<String>();
        writeln!(file, "{safe_line}")
            .map_err(|error| PlatformError::io("写入前端日志失败", error))?;
    }
    Ok(())
}

pub(crate) fn clear_app_log(kind: String) -> Result<(), PlatformError> {
    let path = app_log_path(&kind)?;
    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|error| PlatformError::io("清空日志失败", error))?;
    Ok(())
}
