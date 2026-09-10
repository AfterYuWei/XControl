#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[cfg(desktop)]
    #[error("session keepalive is only available on mobile")]
    Unsupported,
}

pub type Result<T> = std::result::Result<T, Error>;
