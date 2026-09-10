//! Operating-system capability adapters.

pub(crate) mod document_gateway;
pub(crate) mod local_files;

#[cfg(desktop)]
pub(crate) mod desktop;
