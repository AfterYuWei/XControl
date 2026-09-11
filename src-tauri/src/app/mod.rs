//! Application bootstrap and lifecycle composition.

mod bootstrap;
mod events;

pub(crate) use events::TauriEventSink;

pub(crate) use bootstrap::run;
