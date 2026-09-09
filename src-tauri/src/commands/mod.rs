//! Tauri IPC adapter layer.

mod audit;
#[cfg(desktop)]
mod desktop;
mod group;
mod snippet;

pub(crate) use audit::*;
#[cfg(desktop)]
pub(crate) use desktop::*;
pub(crate) use group::*;
pub(crate) use snippet::*;
