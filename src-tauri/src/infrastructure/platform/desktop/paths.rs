use std::path::PathBuf;

use super::PlatformError;

/// 复用 Electron 时代的数据目录，保证数据库、密钥与设置可无感升级。
pub(crate) fn user_data_dir() -> Result<PathBuf, PlatformError> {
    let base = if cfg!(target_os = "linux") {
        dirs::config_dir()
    } else {
        dirs::data_dir()
    }
    .ok_or(PlatformError::Unavailable("无法确定系统数据目录"))?;
    Ok(base.join("XControl"))
}

pub(crate) fn is_test_build() -> bool {
    cfg!(debug_assertions) || option_env!("XCONTROL_BUILD_CHANNEL") == Some("test")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_directory_keeps_legacy_application_name() {
        assert_eq!(user_data_dir().unwrap().file_name().unwrap(), "XControl");
    }
}
