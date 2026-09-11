use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::{KeepaliveRequest, KeepaliveResponse, KeepaliveStatus};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_session_keepalive);

pub struct SessionKeepalive<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<SessionKeepalive<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(
        "com.yuweinfo.eizhu.sessionkeepalive",
        "SessionKeepalivePlugin",
    )?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_session_keepalive)?;
    Ok(SessionKeepalive(handle))
}

impl<R: Runtime> SessionKeepalive<R> {
    pub fn start(&self, request: KeepaliveRequest) -> crate::Result<KeepaliveResponse> {
        self.0
            .run_mobile_plugin("start", request)
            .map_err(Into::into)
    }

    pub fn stop(&self) -> crate::Result<()> {
        self.0.run_mobile_plugin("stop", ()).map_err(Into::into)
    }

    pub fn status(&self) -> crate::Result<KeepaliveStatus> {
        self.0.run_mobile_plugin("status", ()).map_err(Into::into)
    }
}
