#[cfg(mobile)]
use tauri::Manager;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

mod error;
#[cfg(mobile)]
mod mobile;
mod models;

pub use error::{Error, Result};
#[cfg(mobile)]
pub use mobile::MasterKeyStore;
pub use models::{LoadResponse, StoreRequest};

#[cfg(mobile)]
pub trait MasterKeyStoreExt<R: Runtime> {
    fn master_key_store(&self) -> &MasterKeyStore<R>;
}

#[cfg(mobile)]
impl<R: Runtime, T: Manager<R>> MasterKeyStoreExt<R> for T {
    fn master_key_store(&self) -> &MasterKeyStore<R> {
        self.state::<MasterKeyStore<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("master-key-store")
        .setup(|app, api| {
            #[cfg(mobile)]
            {
                let store = mobile::init(app, api)?;
                app.manage(store);
            }
            #[cfg(desktop)]
            let _ = (app, api);
            Ok(())
        })
        .build()
}
