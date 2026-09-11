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
pub use models::SystemInsets;

#[cfg(desktop)]
use desktop::SystemInsetsPlugin;
#[cfg(mobile)]
use mobile::SystemInsetsPlugin;

pub trait SystemInsetsExt<R: Runtime> {
    fn system_insets(&self) -> &SystemInsetsPlugin<R>;
}

impl<R: Runtime, T: Manager<R>> SystemInsetsExt<R> for T {
    fn system_insets(&self) -> &SystemInsetsPlugin<R> {
        self.state::<SystemInsetsPlugin<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("system-insets")
        .setup(|app, api| {
            #[cfg(mobile)]
            let native = mobile::init(app, api)?;
            #[cfg(desktop)]
            let native = desktop::init(app, api)?;
            app.manage(native);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_system_insets])
        .build()
}

/// 读取系统栏/刘海安全区内边距（CSS 像素）。任何平台读取失败都返回全零，
/// 前端会退回 `env(safe-area-inset-*)`。
#[tauri::command]
fn get_system_insets<R: Runtime>(app: tauri::AppHandle<R>) -> SystemInsets {
    app.system_insets().get()
}
