use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::{ExportRequest, ExportResponse, PickRequest, PickResponse};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_document_gateway);

pub struct DocumentGateway<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<DocumentGateway<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(
        "com.yuweinfo.eizhu.documentgateway",
        "DocumentGatewayPlugin",
    )?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_document_gateway)?;
    Ok(DocumentGateway(handle))
}

impl<R: Runtime> DocumentGateway<R> {
    pub fn pick(&self, request: PickRequest) -> crate::Result<PickResponse> {
        self.0
            .run_mobile_plugin("pick", request)
            .map_err(Into::into)
    }

    pub fn export(&self, request: ExportRequest) -> crate::Result<ExportResponse> {
        self.0
            .run_mobile_plugin("export", request)
            .map_err(Into::into)
    }
}
