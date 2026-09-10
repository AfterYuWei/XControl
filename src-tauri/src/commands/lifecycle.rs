//! Application foreground/background IPC adapters.

use chrono::Utc;
use serde::Deserialize;
use tauri::{AppHandle, State};

#[cfg(mobile)]
use tauri_plugin_session_keepalive::{KeepaliveRequest, SessionKeepaliveExt};

use crate::{
    app::{LifecycleCoordinator, LifecycleSnapshot, BACKGROUND_KEEPALIVE_SECONDS},
    error::CommandError,
    sftp::SftpService,
    ssh::SshService,
    sync::SyncService,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LifecyclePhase {
    Foreground,
    Background,
}

#[tauri::command]
pub(crate) fn app_lifecycle_status(
    lifecycle: State<'_, LifecycleCoordinator>,
) -> LifecycleSnapshot {
    lifecycle.snapshot(Utc::now().timestamp_millis())
}

#[tauri::command]
pub(crate) async fn app_lifecycle_update(
    app: AppHandle,
    lifecycle: State<'_, LifecycleCoordinator>,
    sessions: State<'_, SshService>,
    sftp: State<'_, SftpService>,
    sync: State<'_, SyncService>,
    phase: LifecyclePhase,
) -> Result<LifecycleSnapshot, CommandError> {
    let now = Utc::now().timestamp_millis();
    match phase {
        LifecyclePhase::Background => {
            let active = sessions.active_count().await + sftp.active_count().await;
            let snapshot = lifecycle.enter_background(now, active);
            sync.stop_scheduler().await;
            start_native_keepalive(&app, active)?;

            let lifecycle = lifecycle.inner().clone();
            let sessions = sessions.inner().clone();
            let sftp = sftp.inner().clone();
            let generation = snapshot.generation;
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(BACKGROUND_KEEPALIVE_SECONDS))
                    .await;
                if lifecycle.expire_generation(generation, Utc::now().timestamp_millis()) {
                    sessions.suspend_for_background_limit().await;
                    sftp.suspend_for_background_limit().await;
                }
            });
            Ok(snapshot)
        }
        LifecyclePhase::Foreground => {
            stop_native_keepalive(&app)?;
            let (snapshot, expired) = lifecycle.enter_foreground(now);
            let runtime = tauri::async_runtime::handle();
            sync.start_scheduler(runtime.inner())?;
            if expired {
                sessions.reconnect_suspended().await?;
                sftp.reconnect_suspended().await?;
            } else {
                sessions.probe_active().await;
            }
            Ok(snapshot)
        }
    }
}

#[tauri::command]
pub(crate) async fn app_disconnect_all_sessions(
    app: AppHandle,
    lifecycle: State<'_, LifecycleCoordinator>,
    sessions: State<'_, SshService>,
    sftp: State<'_, SftpService>,
) -> Result<LifecycleSnapshot, CommandError> {
    stop_native_keepalive(&app)?;
    sessions.shutdown().await;
    sftp.shutdown().await;
    Ok(lifecycle.enter_foreground(Utc::now().timestamp_millis()).0)
}

#[tauri::command]
pub(crate) async fn app_background_expired(
    lifecycle: State<'_, LifecycleCoordinator>,
    sessions: State<'_, SshService>,
    sftp: State<'_, SftpService>,
) -> Result<LifecycleSnapshot, CommandError> {
    let now = Utc::now().timestamp_millis();
    let snapshot = lifecycle
        .force_expire(now)
        .unwrap_or_else(|| lifecycle.snapshot(now));
    if snapshot.expired {
        sessions.suspend_for_background_limit().await;
        sftp.suspend_for_background_limit().await;
    }
    Ok(snapshot)
}

fn start_native_keepalive(app: &AppHandle, active_sessions: usize) -> Result<(), CommandError> {
    #[cfg(mobile)]
    if active_sessions > 0 {
        app.session_keepalive()
            .start(KeepaliveRequest {
                active_sessions,
                duration_seconds: BACKGROUND_KEEPALIVE_SECONDS,
            })
            .map_err(|error| CommandError::new("BACKGROUND_SERVICE", error.to_string()))?;
    }
    #[cfg(desktop)]
    let _ = (app, active_sessions);
    Ok(())
}

fn stop_native_keepalive(app: &AppHandle) -> Result<(), CommandError> {
    #[cfg(mobile)]
    app.session_keepalive()
        .stop()
        .map_err(|error| CommandError::new("BACKGROUND_SERVICE", error.to_string()))?;
    #[cfg(desktop)]
    let _ = app;
    Ok(())
}
