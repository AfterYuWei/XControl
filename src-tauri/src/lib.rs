//! eizhu Tauri 2 application library.
//!
//! React communicates with the in-process Rust backend through fine-grained
//! Tauri commands and events.

mod app;
mod audit;
mod backup;
mod commands;
mod error;
mod group;
mod infrastructure;
mod profile;
mod server_detail;
mod sftp;
mod snippet;
mod ssh;
mod sync;
mod vault;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::run();
}
