//! Tauri IPC adapter layer.

mod audit;
mod backup;
#[cfg(desktop)]
mod desktop;
mod document;
mod group;
mod lifecycle;
mod platform;
mod profile;
mod server_detail;
mod sftp;
mod snippet;
mod ssh;
mod sync;
mod vault;

pub(crate) use audit::*;
pub(crate) use backup::*;
#[cfg(desktop)]
pub(crate) use desktop::*;
pub(crate) use document::*;
pub(crate) use group::*;
pub(crate) use lifecycle::*;
pub(crate) use platform::*;
pub(crate) use profile::*;
pub(crate) use server_detail::*;
pub(crate) use sftp::*;
pub(crate) use snippet::*;
pub(crate) use ssh::*;
pub(crate) use sync::*;
pub(crate) use vault::*;
