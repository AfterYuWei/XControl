//! Operating-system capability adapters.

pub(crate) mod document_gateway;
pub(crate) mod local_files;
#[cfg(any(mobile, test))]
pub(crate) mod master_key_store;

#[cfg(desktop)]
pub(crate) mod desktop;
