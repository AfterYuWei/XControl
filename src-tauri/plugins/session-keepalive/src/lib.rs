use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;
mod models;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

pub use error::{Error, Result};
pub use models::{KeepaliveRequest, KeepaliveResponse, KeepaliveStatus};

#[cfg(desktop)]
use desktop::SessionKeepalive;
#[cfg(mobile)]
use mobile::SessionKeepalive;

pub trait SessionKeepaliveExt<R: Runtime> {
    fn session_keepalive(&self) -> &SessionKeepalive<R>;
}

impl<R: Runtime, T: Manager<R>> SessionKeepaliveExt<R> for T {
    fn session_keepalive(&self) -> &SessionKeepalive<R> {
        self.state::<SessionKeepalive<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("session-keepalive")
        .setup(|app, api| {
            #[cfg(mobile)]
            let keepalive = mobile::init(app, api)?;
            #[cfg(desktop)]
            let keepalive = desktop::init(app, api)?;
            app.manage(keepalive);
            Ok(())
        })
        .build()
}
