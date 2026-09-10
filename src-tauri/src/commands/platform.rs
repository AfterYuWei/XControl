//! Cross-platform runtime capability discovery.
//!
//! The frontend must not infer native capabilities from a user-agent string:
//! Android and iOS are Tauri runtimes too, but they do not expose the desktop
//! window, updater or drag-out commands.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlatformCapabilities {
    pub platform: &'static str,
    pub runtime: &'static str,
    pub window_controls: bool,
    pub app_updates: bool,
    pub drag_out: bool,
    pub native_file_paths: bool,
    pub document_picker: bool,
    pub secure_key_store: bool,
    pub biometric: bool,
    pub background_mode: &'static str,
    pub max_concurrent_transfers: u8,
}

#[tauri::command]
pub(crate) fn platform_capabilities() -> PlatformCapabilities {
    PlatformCapabilities {
        platform: current_platform(),
        runtime: if cfg!(mobile) { "mobile" } else { "desktop" },
        window_controls: cfg!(desktop),
        app_updates: cfg!(desktop),
        drag_out: cfg!(desktop),
        native_file_paths: cfg!(desktop),
        // These capabilities become true only when the corresponding mobile
        // adapters are installed in later migration stages.
        document_picker: cfg!(desktop),
        secure_key_store: false,
        biometric: false,
        background_mode: "unsupported",
        max_concurrent_transfers: if cfg!(mobile) { 2 } else { 5 },
    }
}

const fn current_platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_capabilities_match_the_compiled_target() {
        let capabilities = platform_capabilities();
        assert_eq!(capabilities.runtime, "desktop");
        assert!(capabilities.window_controls);
        assert!(capabilities.app_updates);
        assert_eq!(capabilities.max_concurrent_transfers, 5);
        assert_ne!(capabilities.platform, "unknown");
    }
}
