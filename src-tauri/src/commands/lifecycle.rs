//! Application foreground/background IPC adapters.

use chrono::Utc;
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppDiagnostics {
    #[serde(flatten)]
    lifecycle: LifecycleSnapshot,
    platform: &'static str,
    android_foreground_service: Option<bool>,
    notification_permission: Option<bool>,
    ios_background_time_remaining_seconds: Option<u64>,
    recent_reason: String,
}

#[derive(Default)]
struct NativeKeepaliveStatus {
    running: bool,
    notification_permission: bool,
    background_time_remaining_seconds: Option<u64>,
    network_generation: u64,
    network_state: Option<String>,
}

#[tauri::command]
pub(crate) fn app_lifecycle_status(
    lifecycle: State<'_, LifecycleCoordinator>,
) -> LifecycleSnapshot {
    lifecycle.snapshot(Utc::now().timestamp_millis())
}

#[tauri::command]
pub(crate) async fn app_network_update(
    lifecycle: State<'_, LifecycleCoordinator>,
    sessions: State<'_, SshService>,
    sftp: State<'_, SftpService>,
    online: bool,
    generation: Option<u64>,
) -> Result<LifecycleSnapshot, CommandError> {
    let before = lifecycle.snapshot(Utc::now().timestamp_millis());
    let snapshot = lifecycle.update_network(online, generation, Utc::now().timestamp_millis());
    log_lifecycle("network_change", &snapshot);
    if online && !snapshot.expired && snapshot.network_generation != before.network_generation {
        if generation.is_some() {
            sessions.reconnect_active().await?;
            sftp.reconnect_active().await?;
        } else {
            sessions.probe_active().await;
            sftp.probe_active().await;
        }
    }
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn app_diagnostics(
    app: AppHandle,
    lifecycle: State<'_, LifecycleCoordinator>,
    sessions: State<'_, SshService>,
    sftp: State<'_, SftpService>,
) -> Result<AppDiagnostics, CommandError> {
    let native = native_keepalive_status(&app)?;
    let lifecycle = native
        .network_state
        .as_deref()
        .map(|state| {
            lifecycle.update_network(
                state == "online",
                Some(native.network_generation),
                Utc::now().timestamp_millis(),
            )
        })
        .unwrap_or_else(|| lifecycle.snapshot(Utc::now().timestamp_millis()));
    let recent_reason = sessions
        .latest_reason()
        .await
        .or(sftp.latest_reason().await)
        .unwrap_or_else(|| lifecycle.last_reason.clone());
    Ok(AppDiagnostics {
        lifecycle,
        platform: super::platform::current_platform(),
        android_foreground_service: cfg!(target_os = "android").then_some(native.running),
        notification_permission: cfg!(target_os = "android")
            .then_some(native.notification_permission),
        ios_background_time_remaining_seconds: native.background_time_remaining_seconds,
        recent_reason,
    })
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
            log_lifecycle("entered_background", &snapshot);
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
            let before = lifecycle.snapshot(now);
            let native = native_keepalive_status(&app)?;
            let network_changed = native.network_state.as_deref().is_some_and(|state| {
                lifecycle
                    .update_network(state == "online", Some(native.network_generation), now)
                    .network_generation
                    != before.network_generation
            });
            stop_native_keepalive(&app)?;
            let (snapshot, expired) = lifecycle.enter_foreground(now);
            log_lifecycle("entered_foreground", &snapshot);
            let runtime = tauri::async_runtime::handle();
            sync.start_scheduler(runtime.inner())?;
            if expired {
                sessions.reconnect_suspended().await?;
                sftp.reconnect_suspended().await?;
            } else if network_changed {
                sessions.reconnect_active().await?;
                sftp.reconnect_active().await?;
            } else {
                sessions.probe_active().await;
                sftp.probe_active().await;
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
    let snapshot = lifecycle.enter_foreground(Utc::now().timestamp_millis()).0;
    log_lifecycle("disconnect_all", &snapshot);
    Ok(snapshot)
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
    log_lifecycle("background_expired", &snapshot);
    Ok(snapshot)
}

fn log_lifecycle(event: &str, snapshot: &LifecycleSnapshot) {
    eprintln!(
        "{}",
        serde_json::json!({
            "event": event,
            "platform": super::platform::current_platform(),
            "session_id": "",
            "lifecycle_state": snapshot.state,
            "network_generation": snapshot.network_generation,
            "background_elapsed_seconds": snapshot.background_elapsed_seconds,
        })
    );
}

fn native_keepalive_status(app: &AppHandle) -> Result<NativeKeepaliveStatus, CommandError> {
    #[cfg(mobile)]
    return app
        .session_keepalive()
        .status()
        .map(|status| NativeKeepaliveStatus {
            running: status.running,
            notification_permission: status.notification_permission,
            background_time_remaining_seconds: status.background_time_remaining_seconds,
            network_generation: status.network_generation,
            network_state: status.network_state,
        })
        .map_err(|error| CommandError::new("BACKGROUND_SERVICE", error.to_string()));
    #[cfg(desktop)]
    {
        let _ = app;
        Ok(NativeKeepaliveStatus::default())
    }
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
