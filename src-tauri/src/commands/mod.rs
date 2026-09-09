//! Tauri IPC adapter layer.

mod audit;
mod backup;
#[cfg(desktop)]
mod desktop;
mod group;
mod profile;
mod snippet;
mod vault;

pub(crate) use audit::*;
pub(crate) use backup::*;
#[cfg(desktop)]
pub(crate) use desktop::*;
pub(crate) use group::*;
pub(crate) use profile::*;
pub(crate) use snippet::*;
pub(crate) use vault::*;
