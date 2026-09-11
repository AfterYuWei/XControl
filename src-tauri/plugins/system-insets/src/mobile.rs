use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::SystemInsets;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_system_insets);

pub struct SystemInsetsPlugin<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<SystemInsetsPlugin<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(
        "com.yuweinfo.eizhu.systeminsets",
        "SystemInsetsPlugin",
    )?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_system_insets)?;
    Ok(SystemInsetsPlugin(handle))
}

impl<R: Runtime> SystemInsetsPlugin<R> {
    /// 读取失败时退回全零，前端 CSS 会继续使用 env(safe-area-inset-*)。
    pub fn get(&self) -> SystemInsets {
        self.0
            .run_mobile_plugin("get", ())
            .unwrap_or_default()
    }
}
