//! Application bootstrap and lifecycle composition.

mod bootstrap;
mod events;
mod lifecycle;

pub(crate) use events::TauriEventSink;
pub(crate) use lifecycle::{LifecycleCoordinator, LifecycleSnapshot, BACKGROUND_KEEPALIVE_SECONDS};

pub(crate) use bootstrap::run;
