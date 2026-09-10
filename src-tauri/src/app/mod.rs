//! Application bootstrap and lifecycle composition.

mod bootstrap;
mod events;
mod lifecycle;
mod logging;

pub(crate) use events::TauriEventSink;
pub(crate) use lifecycle::{
    LifecycleCoordinator, LifecycleSnapshot, BACKGROUND_KEEPALIVE_SECONDS,
    RECONNECT_BACKOFF_SECONDS,
};
pub(crate) use logging::{log_runtime_error, log_runtime_event};

pub(crate) use bootstrap::run;
