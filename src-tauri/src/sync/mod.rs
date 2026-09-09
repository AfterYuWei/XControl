//! 本地版本、云端 Provider 与调度的进程内同步领域。

mod cloud;
mod error;
mod model;
mod oauth;
mod provider;
mod repository;
mod scheduler;
mod service;

pub(crate) use model::{
    SyncEvent, SyncProviderConfig, SyncProviderMeta, SyncSettings, SyncStatus, SyncVersion,
};
pub(crate) use repository::SyncRepository;
pub(crate) use service::{BackupNowResult, RestoreResult, SyncService, ORIGIN_MANUAL};
