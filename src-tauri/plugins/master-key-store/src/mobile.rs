use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::{LoadResponse, StoreRequest};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_master_key_store);

pub struct MasterKeyStore<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<MasterKeyStore<R>> {
    #[cfg(target_os = "android")]
    let handle =
        api.register_android_plugin("com.yuweinfo.eizhu.masterkeystore", "MasterKeyStorePlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_master_key_store)?;
    Ok(MasterKeyStore(handle))
}

impl<R: Runtime> MasterKeyStore<R> {
    pub fn load(&self) -> crate::Result<LoadResponse> {
        self.0.run_mobile_plugin("load", ()).map_err(Into::into)
    }

    pub fn store(&self, request: StoreRequest<'_>) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("store", request)
            .map_err(Into::into)
    }
}
