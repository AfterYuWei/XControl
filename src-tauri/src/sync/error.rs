//! Typed runtime failures for synchronization coordination and scheduling.

use crate::error::CommandError;

#[derive(Debug, thiserror::Error)]
pub(super) enum SyncError {
    #[error("同步操作进行中，请稍后")]
    InProgress,
    #[error("同步调度器锁已损坏")]
    SchedulerPoisoned,
    #[error("同步调度器尚未启动")]
    SchedulerNotStarted,
    #[error("同步请求队列已满，请稍后重试")]
    SchedulerBusy,
    #[error("同步调度器已停止")]
    SchedulerStopped,
}

impl From<SyncError> for CommandError {
    fn from(error: SyncError) -> Self {
        let code = match &error {
            SyncError::InProgress => "SYNC_IN_PROGRESS",
            SyncError::SchedulerBusy => "SYNC_SCHEDULER_BUSY",
            SyncError::SchedulerNotStarted | SyncError::SchedulerStopped => {
                "SYNC_SCHEDULER_STOPPED"
            }
            SyncError::SchedulerPoisoned => "SYNC_FAILED",
        };
        Self::new(code, error.to_string())
    }
}
