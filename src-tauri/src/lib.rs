//! XControl Tauri 2 application library.
//!
//! React communicates with the in-process Rust backend through fine-grained
//! Tauri commands and events.

mod app;
mod audit;
mod backup;
mod commands;
#[cfg(desktop)]
mod drag_out;
mod error;
mod group;
mod infrastructure;
mod profile;
mod runtime;
mod server_detail;
#[cfg(desktop)]
mod settings_migrate;
mod sftp;
mod snippet;
mod ssh;
mod sync;
mod vault;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::run();
}
