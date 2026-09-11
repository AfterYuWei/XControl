use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::SystemInsets;

pub struct SystemInsetsPlugin<R: Runtime>(AppHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<SystemInsetsPlugin<R>> {
    Ok(SystemInsetsPlugin(app.clone()))
}

impl<R: Runtime> SystemInsetsPlugin<R> {
    pub fn get(&self) -> SystemInsets {
        let _ = &self.0;
        SystemInsets::default()
    }
}
