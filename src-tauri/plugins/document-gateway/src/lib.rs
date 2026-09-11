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
use mobile::DocumentGateway;
pub use models::{ExportRequest, ExportResponse, NativeDocument, PickRequest, PickResponse};

#[cfg(mobile)]
pub trait DocumentGatewayExt<R: Runtime> {
    fn document_gateway(&self) -> &DocumentGateway<R>;
}

#[cfg(mobile)]
impl<R: Runtime, T: Manager<R>> DocumentGatewayExt<R> for T {
    fn document_gateway(&self) -> &DocumentGateway<R> {
        self.state::<DocumentGateway<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("document-gateway")
        .setup(|app, api| {
            #[cfg(mobile)]
            app.manage(mobile::init(app, api)?);
            #[cfg(desktop)]
            let _ = (app, api);
            Ok(())
        })
        .build()
}
