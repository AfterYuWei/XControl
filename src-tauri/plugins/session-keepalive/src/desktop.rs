use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::{KeepaliveRequest, KeepaliveResponse, KeepaliveStatus};

pub struct SessionKeepalive<R: Runtime>(AppHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<SessionKeepalive<R>> {
    Ok(SessionKeepalive(app.clone()))
}

impl<R: Runtime> SessionKeepalive<R> {
    pub fn start(&self, _request: KeepaliveRequest) -> crate::Result<KeepaliveResponse> {
        let _ = &self.0;
        Ok(KeepaliveResponse::default())
    }

    pub fn stop(&self) -> crate::Result<()> {
        let _ = &self.0;
        Ok(())
    }

    pub fn status(&self) -> crate::Result<KeepaliveStatus> {
        let _ = &self.0;
        Ok(KeepaliveStatus::default())
    }
}
