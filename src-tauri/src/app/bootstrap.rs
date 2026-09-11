//! Tauri application composition root.

use crate::{backup, commands, profile, sftp, ssh, sync, vault};

#[cfg(desktop)]
use crate::infrastructure::platform::desktop;

pub(crate) fn run() {
    #[cfg(desktop)]
    desktop_run();

    // 移动端复用同一套进程内 Rust 领域。
    #[cfg(mobile)]
    {
        tauri::Builder::default()
            .plugin(tauri_plugin_deep_link::init())
            .plugin(tauri_plugin_session_keepalive::init())
            .plugin(tauri_plugin_document_gateway::init())
            .plugin(tauri_plugin_master_key_store::init())
            .invoke_handler(tauri::generate_handler![
                commands::platform_capabilities,
                commands::app_lifecycle_status,
                commands::app_network_update,
                commands::app_diagnostics,
                commands::app_lifecycle_update,
                commands::app_background_expired,
                commands::app_disconnect_all_sessions,
                commands::document_pick,
                commands::document_release,
                commands::document_read_text,
                commands::document_export_text,
                commands::sftp_upload_document,
                commands::sftp_export_download,
                commands::snippet_list,
                commands::snippet_create,
                commands::snippet_update,
                commands::snippet_delete,
                commands::group_list,
                commands::group_create,
                commands::group_update,
                commands::group_delete,
                commands::audit_list,
                commands::vault_list,
                commands::vault_get,
                commands::vault_create,
                commands::vault_update,
                commands::vault_delete,
                commands::vault_references,
                commands::vault_reveal,
                commands::vault_generate_key_pair,
                commands::profile_list,
                commands::profile_get,
                commands::profile_create,
                commands::profile_update,
                commands::profile_delete,
                commands::profile_test_new,
                commands::profile_test_existing,
                commands::profile_confirm_host_key,
                commands::session_create,
                commands::session_list,
                commands::session_attach,
                commands::session_subscribe,
                commands::session_unsubscribe,
                commands::session_reconnect,
                commands::session_confirm_host_key,
                commands::host_key_decide,
                commands::session_input,
                commands::session_resize,
                commands::session_ping,
                commands::session_auth_respond,
                commands::session_complete,
                commands::session_close,
                commands::sftp_create_session,
                commands::sftp_get_session,
                commands::sftp_reconnect_session,
                commands::sftp_host_key_decide,
                commands::sftp_list_sessions,
                commands::sftp_close_session,
                commands::sftp_list,
                commands::sftp_stat,
                commands::sftp_tree,
                commands::sftp_mkdir,
                commands::sftp_rename,
                commands::sftp_delete,
                commands::sftp_read_file,
                commands::sftp_write_file,
                commands::sftp_upload_begin,
                commands::sftp_upload_chunk,
                commands::sftp_upload_chunk_base64,
                commands::sftp_upload_finish,
                commands::sftp_upload_abort,
                commands::sftp_download,
                commands::sftp_download_chunk,
                commands::sftp_download_chunk_base64,
                commands::sftp_download_close,
                commands::sftp_list_transfers,
                commands::sftp_cancel_transfer,
                commands::sftp_clear_completed_transfers,
                commands::sftp_transfer,
                commands::sftp_move,
                commands::server_get_info,
                commands::server_get_metrics,
                commands::backup_pick_file,
                commands::backup_export,
                commands::backup_preview,
                commands::backup_import,
                commands::sync_status,
                commands::sync_backup_now,
                commands::sync_versions,
                commands::sync_restore_version,
                commands::sync_delete_version,
                commands::sync_events,
                commands::sync_get_settings,
                commands::sync_update_settings,
                commands::sync_reveal_password,
                commands::sync_shutdown,
                commands::sync_now,
                commands::sync_push,
                commands::sync_resolve_conflict,
                commands::sync_providers,
                commands::sync_create_provider,
                commands::sync_update_provider,
                commands::sync_delete_provider,
                commands::sync_test_provider,
                commands::sync_oauth_url
            ])
            .setup(|app| {
                use tauri::Manager;
                let data_dir = app.path().app_data_dir()?;
                let document_gateway =
                    crate::infrastructure::platform::document_gateway::DocumentGateway::initialize(
                        app.path().app_cache_dir()?.join("document-gateway"),
                    )?;
                let database = crate::infrastructure::database::Database::initialize(
                    data_dir.join("eizhu.db"),
                )
                .map_err(|error| std::io::Error::other(error.to_string()))?;
                let encryptor = crate::infrastructure::platform::master_key_store::load_or_create(
                    app.handle(),
                    &database,
                    &data_dir.join("key"),
                )
                .map_err(|error| std::io::Error::other(error.to_string()))?;
                let audit = crate::audit::AuditRepository::new(database.clone());
                let vault =
                    vault::VaultService::new(database.clone(), encryptor.clone(), audit.clone());
                let profiles = profile::ProfileService::initialize(
                    database.clone(),
                    encryptor.clone(),
                    vault.clone(),
                )?;
                let groups = crate::group::GroupService::new(database.clone());
                let backup = backup::BackupService::new(
                    database.clone(),
                    encryptor.clone(),
                    audit.clone(),
                    groups.clone(),
                    profiles.clone(),
                    vault.clone(),
                );
                let sync = sync::SyncService::initialize(
                    sync::SyncRepository::new(database.clone(), encryptor.clone()),
                    backup.clone(),
                    data_dir.join("backups"),
                )?;
                let runtime = tauri::async_runtime::handle();
                sync.start_scheduler(runtime.inner())?;
                install_oauth_deep_links(app, &sync)?;
                let events = std::sync::Arc::new(super::TauriEventSink::new(app.handle().clone()));
                let sessions =
                    ssh::SshService::new(profiles.clone(), audit.clone(), events.clone());
                let sftp = sftp::SftpService::new(profiles.clone(), audit.clone(), events);
                app.manage(crate::snippet::SnippetService::new(database.clone()));
                app.manage(super::LifecycleCoordinator::new());
                app.manage(document_gateway);
                app.manage(groups);
                app.manage(vault);
                app.manage(profiles);
                app.manage(backup);
                app.manage(sync);
                app.manage(sessions);
                app.manage(sftp);
                app.manage(audit);
                Ok(())
            })
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    }
}

#[cfg(desktop)]
fn desktop_run() {
    use tauri::Manager;

    let smoke = std::env::args().any(|arg| arg == "--smoke-test");

    tauri::Builder::default()
        // 单实例锁：二次启动聚焦已有窗口（等价 Electron requestSingleInstanceLock）
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        // 外部链接走系统默认浏览器（等价 Electron shell.openExternal + setWindowOpenHandler）
        .plugin(tauri_plugin_opener::init())
        // 文件对话框（备份导入/导出与私钥文本保存）
        .plugin(tauri_plugin_dialog::init())
        // 文件拖出到系统（sftp_drag_out 物化后由前端 startDrag 接管）
        .plugin(tauri_plugin_drag::init())
        // 应用内更新（stable/test 双通道）+ 更新后重启
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::platform_capabilities,
            commands::app_lifecycle_status,
            commands::app_network_update,
            commands::app_diagnostics,
            commands::app_lifecycle_update,
            commands::app_background_expired,
            commands::app_disconnect_all_sessions,
            commands::document_pick,
            commands::document_release,
            commands::document_read_text,
            commands::document_export_text,
            commands::sftp_upload_document,
            commands::sftp_export_download,
            commands::frontend_ready,
            commands::get_platform,
            commands::read_app_log,
            commands::append_frontend_log,
            commands::clear_app_log,
            commands::migrate_electron_settings,
            commands::mark_electron_settings_migrated,
            commands::save_blob_to_disk,
            commands::backup_pick_file,
            commands::backup_export,
            commands::backup_preview,
            commands::backup_import,
            commands::sftp_drag_out,
            commands::snippet_list,
            commands::snippet_create,
            commands::snippet_update,
            commands::snippet_delete,
            commands::group_list,
            commands::group_create,
            commands::group_update,
            commands::group_delete,
            commands::audit_list,
            commands::vault_list,
            commands::vault_get,
            commands::vault_create,
            commands::vault_update,
            commands::vault_delete,
            commands::vault_references,
            commands::vault_reveal,
            commands::vault_generate_key_pair,
            commands::profile_list,
            commands::profile_get,
            commands::profile_create,
            commands::profile_update,
            commands::profile_delete,
            commands::profile_test_new,
            commands::profile_test_existing,
            commands::profile_confirm_host_key,
            commands::session_create,
            commands::session_list,
            commands::session_attach,
            commands::session_subscribe,
            commands::session_unsubscribe,
            commands::session_reconnect,
            commands::session_confirm_host_key,
            commands::host_key_decide,
            commands::session_input,
            commands::session_resize,
            commands::session_ping,
            commands::session_auth_respond,
            commands::session_complete,
            commands::session_close,
            commands::sftp_create_session,
            commands::sftp_get_session,
            commands::sftp_reconnect_session,
            commands::sftp_host_key_decide,
            commands::sftp_list_sessions,
            commands::sftp_close_session,
            commands::sftp_list,
            commands::sftp_stat,
            commands::sftp_tree,
            commands::sftp_mkdir,
            commands::sftp_rename,
            commands::sftp_delete,
            commands::sftp_read_file,
            commands::sftp_write_file,
            commands::sftp_upload_begin,
            commands::sftp_upload_chunk,
            commands::sftp_upload_chunk_base64,
            commands::sftp_upload_finish,
            commands::sftp_upload_abort,
            commands::sftp_download,
            commands::sftp_download_chunk,
            commands::sftp_download_chunk_base64,
            commands::sftp_download_close,
            commands::sftp_list_transfers,
            commands::sftp_cancel_transfer,
            commands::sftp_clear_completed_transfers,
            commands::sftp_transfer,
            commands::sftp_move,
            commands::server_get_info,
            commands::server_get_metrics,
            commands::sync_status,
            commands::sync_backup_now,
            commands::sync_versions,
            commands::sync_restore_version,
            commands::sync_delete_version,
            commands::sync_events,
            commands::sync_get_settings,
            commands::sync_update_settings,
            commands::sync_reveal_password,
            commands::sync_shutdown,
            commands::sync_now,
            commands::sync_push,
            commands::sync_resolve_conflict,
            commands::sync_providers,
            commands::sync_create_provider,
            commands::sync_update_provider,
            commands::sync_delete_provider,
            commands::sync_test_provider,
            commands::sync_oauth_url
        ])
        .setup(move |app| {
            let data_dir = desktop::user_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let document_gateway =
                crate::infrastructure::platform::document_gateway::DocumentGateway::initialize(
                    app.path().app_cache_dir()?.join("document-gateway"),
                )?;
            let database =
                crate::infrastructure::database::Database::initialize(data_dir.join("eizhu.db"))
                    .map_err(|error| std::io::Error::other(error.to_string()))?;
            let encryptor = vault::Encryptor::load_or_create(data_dir.join("key"))
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let audit = crate::audit::AuditRepository::new(database.clone());
            let vault =
                vault::VaultService::new(database.clone(), encryptor.clone(), audit.clone());
            let profiles = profile::ProfileService::initialize(
                database.clone(),
                encryptor.clone(),
                vault.clone(),
            )?;
            let groups = crate::group::GroupService::new(database.clone());
            let backup = backup::BackupService::new(
                database.clone(),
                encryptor.clone(),
                audit.clone(),
                groups.clone(),
                profiles.clone(),
                vault.clone(),
            );
            let sync = sync::SyncService::initialize(
                sync::SyncRepository::new(database.clone(), encryptor.clone()),
                backup.clone(),
                data_dir.join("backups"),
            )?;
            let runtime = tauri::async_runtime::handle();
            sync.start_scheduler(runtime.inner())?;
            install_oauth_deep_links(app, &sync)?;
            let events = std::sync::Arc::new(super::TauriEventSink::new(app.handle().clone()));
            let sessions = ssh::SshService::new(profiles.clone(), audit.clone(), events.clone());
            let sftp = sftp::SftpService::new(profiles.clone(), audit.clone(), events);
            app.manage(crate::snippet::SnippetService::new(database.clone()));
            app.manage(super::LifecycleCoordinator::new());
            app.manage(document_gateway);
            app.manage(groups);
            app.manage(vault);
            app.manage(profiles);
            app.manage(backup);
            app.manage(sync);
            app.manage(sessions);
            app.manage(sftp);
            app.manage(audit);
            desktop::sweep_stale_drag_temps();
            if smoke {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    if let Some(path) = std::env::var_os("EIZHU_SMOKE_MARKER_PATH") {
                        let _ = std::fs::write(path, "EIZHU_TAURI_SMOKE_OK\n");
                    }
                    println!("EIZHU_TAURI_SMOKE_OK");
                    handle.exit(0);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let sync = app_handle.state::<sync::SyncService>().inner().clone();
                let sessions = app_handle.state::<ssh::SshService>().inner().clone();
                let sftp = app_handle.state::<sftp::SftpService>().inner().clone();
                tauri::async_runtime::block_on(async {
                    sessions.shutdown().await;
                    sftp.shutdown().await;
                    sync.stop_scheduler().await;
                    sync.shutdown_backup().await;
                });
            }
        });
}

fn install_oauth_deep_links<R: tauri::Runtime>(
    app: &tauri::App<R>,
    sync: &sync::SyncService,
) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Emitter;
    use tauri_plugin_deep_link::DeepLinkExt;

    #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
    let _ = app.deep_link().register_all();

    let handle = app.handle().clone();
    let state = sync.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            let raw = url.to_string();
            if !raw.starts_with("eizhu://oauth/") {
                continue;
            }
            let handle = handle.clone();
            let state = state.clone();
            tauri::async_runtime::spawn(async move {
                let result = state.complete_oauth_url(&raw).await;
                let payload = match result {
                    Ok(provider_id) => serde_json::json!({
                        "ok": true,
                        "provider_id": provider_id,
                    }),
                    Err(error) => serde_json::json!({
                        "ok": false,
                        "error": error.message,
                    }),
                };
                let _ = handle.emit("sync-oauth-complete", payload);
            });
        }
    });

    if let Some(urls) = app.deep_link().get_current()? {
        for url in urls {
            let raw = url.to_string();
            if raw.starts_with("eizhu://oauth/") {
                let handle = app.handle().clone();
                let state = sync.clone();
                tauri::async_runtime::spawn(async move {
                    let result = state.complete_oauth_url(&raw).await;
                    let _ = handle.emit(
                        "sync-oauth-complete",
                        match result {
                            Ok(provider_id) => {
                                serde_json::json!({"ok": true, "provider_id": provider_id})
                            }
                            Err(error) => {
                                serde_json::json!({"ok": false, "error": error.message})
                            }
                        },
                    );
                });
            }
        }
    }
    Ok(())
}
