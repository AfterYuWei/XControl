use std::{future::pending, time::Duration};

use chrono::{Local, NaiveTime, TimeZone};
use tokio::{
    sync::mpsc,
    time::{Instant, Sleep},
};

use crate::error::CommandError;

use super::manager::{SyncState, ORIGIN_CHANGE, ORIGIN_SCHEDULED, ORIGIN_SHUTDOWN};

const CHANNEL_CAPACITY: usize = 32;

pub(crate) struct SchedulerRuntime {
    sender: mpsc::Sender<Message>,
    task: tauri::async_runtime::JoinHandle<()>,
}

enum Message {
    Reload,
    Change,
    Sync,
    Push,
    Stop,
}

impl SyncState {
    pub fn start_scheduler(&self) -> Result<(), CommandError> {
        let mut slot = self
            .inner
            .scheduler
            .lock()
            .map_err(|_| CommandError::new("SYNC_FAILED", "同步调度器锁已损坏"))?;
        if slot.is_some() {
            return Ok(());
        }
        let (sender, receiver) = mpsc::channel(CHANNEL_CAPACITY);
        let state = self.clone();
        let task = tauri::async_runtime::spawn(async move { run(state, receiver).await });
        *slot = Some(SchedulerRuntime { sender, task });
        Ok(())
    }

    pub fn notify_change(&self) {
        self.send_scheduler(Message::Change);
    }

    pub fn reload_scheduler(&self) {
        self.send_scheduler(Message::Reload);
    }

    pub fn request_sync(&self) {
        self.send_scheduler(Message::Sync);
    }

    pub fn request_push(&self) {
        self.send_scheduler(Message::Push);
    }

    fn send_scheduler(&self, message: Message) {
        let Ok(slot) = self.inner.scheduler.lock() else {
            return;
        };
        if let Some(runtime) = slot.as_ref() {
            let _ = runtime.sender.try_send(message);
        }
    }

    pub async fn stop_scheduler(&self) {
        let runtime = self
            .inner
            .scheduler
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        if let Some(runtime) = runtime {
            let _ = runtime.sender.send(Message::Stop).await;
            let _ = runtime.task.await;
        }
    }

    pub async fn shutdown_backup(&self) {
        let Ok(settings) = self.inner.repository.load_settings() else {
            return;
        };
        if !settings.auto_backup_enabled {
            return;
        }
        let state = self.clone();
        let work = async move {
            tokio::task::spawn_blocking(move || state.create_version(ORIGIN_SHUTDOWN))
                .await
                .map_err(|error| {
                    CommandError::new("SYNC_FAILED", format!("退出备份任务失败: {error}"))
                })?
        };
        if let Ok(Err(error)) = tokio::time::timeout(Duration::from_secs(5), work).await {
            if error.code != "SYNC_PASSWORD_REQUIRED" {
                eprintln!("shutdown backup failed: {error}");
            }
        }
    }
}

async fn run(state: SyncState, mut receiver: mpsc::Receiver<Message>) {
    let mut scheduled_at = next_scheduled_in(&state).map(|delay| Instant::now() + delay);
    let mut debounce_at: Option<Instant> = None;
    loop {
        tokio::select! {
            message = receiver.recv() => match message {
                Some(Message::Stop) | None => break,
                Some(Message::Reload) => {
                    scheduled_at = next_scheduled_in(&state).map(|delay| Instant::now() + delay);
                }
                Some(Message::Change) => {
                    let delay = state.inner.repository.load_settings()
                        .map(|settings| Duration::from_secs(settings.change_debounce_seconds.max(5) as u64))
                        .unwrap_or(Duration::from_secs(30));
                    debounce_at = Some(Instant::now() + delay);
                }
                Some(Message::Sync) => {
                    if let Err(error) = state.sync_all().await {
                        eprintln!("manual sync failed: {error}");
                    }
                }
                Some(Message::Push) => {
                    if let Err(error) = state.push_latest().await {
                        eprintln!("manual push failed: {error}");
                    }
                }
            },
            _ = sleep_optional(scheduled_at) => {
                fire(&state, ORIGIN_SCHEDULED).await;
                scheduled_at = next_scheduled_in(&state).map(|delay| Instant::now() + delay);
            }
            _ = sleep_optional(debounce_at) => {
                debounce_at = None;
                fire(&state, ORIGIN_CHANGE).await;
            }
        }
    }
}

async fn fire(state: &SyncState, origin: &'static str) {
    let Ok(settings) = state.inner.repository.load_settings() else {
        return;
    };
    if origin == ORIGIN_SCHEDULED && !settings.scheduled_enabled {
        return;
    }
    if origin == ORIGIN_CHANGE && !settings.auto_backup_enabled {
        return;
    }
    let cloned = state.clone();
    let result = tokio::time::timeout(
        Duration::from_secs(120),
        tokio::task::spawn_blocking(move || cloned.create_version(origin)),
    )
    .await;
    match result {
        Ok(Ok(Ok(Some(version)))) => {
            eprintln!(
                "sync version created: v{} origin={} size={}",
                version.version, origin, version.size
            );
            if let Err(error) = state.push_latest().await {
                eprintln!("automatic cloud push failed: {error}");
            }
            if settings.sync_mode == "auto" {
                let _ = state.sync_all().await;
            }
        }
        Ok(Ok(Ok(None))) => {}
        Ok(Ok(Err(error))) if error.code == "SYNC_PASSWORD_REQUIRED" => {}
        Ok(Ok(Err(error))) => {
            state
                .inner
                .repository
                .log_event("", "backup", 0, false, &error.message);
        }
        Ok(Err(error)) => state.inner.repository.log_event(
            "",
            "backup",
            0,
            false,
            &format!("调度任务异常结束: {error}"),
        ),
        Err(_) => state
            .inner
            .repository
            .log_event("", "backup", 0, false, "同步备份超时"),
    }
}

fn next_scheduled_in(state: &SyncState) -> Option<Duration> {
    let settings = state.inner.repository.load_settings().ok()?;
    if !settings.scheduled_enabled {
        return None;
    }
    let mut delays = Vec::with_capacity(2);
    if settings.scheduled_interval_hours > 0 {
        delays.push(Duration::from_secs(
            settings.scheduled_interval_hours as u64 * 3600,
        ));
    }
    if let Ok(time) = NaiveTime::parse_from_str(&settings.scheduled_daily_time, "%H:%M") {
        let now = Local::now();
        let mut next = Local
            .from_local_datetime(&now.date_naive().and_time(time))
            .single()?;
        if next <= now {
            next += chrono::Duration::days(1);
        }
        if let Ok(delay) = (next - now).to_std() {
            delays.push(delay);
        }
    }
    delays.into_iter().min()
}

async fn sleep_optional(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => {
            let sleep: Sleep = tokio::time::sleep_until(deadline);
            sleep.await;
        }
        None => pending::<()>().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::model::SyncSettings;

    #[test]
    fn daily_and_interval_choose_earlier_deadline() {
        let now = Local::now();
        let daily = (now + chrono::Duration::minutes(10))
            .format("%H:%M")
            .to_string();
        let mut settings = SyncSettings::default();
        settings.scheduled_enabled = true;
        settings.scheduled_interval_hours = 2;
        settings.scheduled_daily_time = daily;
        let mut delays = vec![Duration::from_secs(
            settings.scheduled_interval_hours as u64 * 3600,
        )];
        let time = NaiveTime::parse_from_str(&settings.scheduled_daily_time, "%H:%M").unwrap();
        let mut next = Local
            .from_local_datetime(&now.date_naive().and_time(time))
            .single()
            .unwrap();
        if next <= now {
            next += chrono::Duration::days(1);
        }
        delays.push((next - now).to_std().unwrap());
        assert!(delays.into_iter().min().unwrap() < Duration::from_secs(7200));
    }
}
