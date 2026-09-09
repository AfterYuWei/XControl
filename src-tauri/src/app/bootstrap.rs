//! Tauri application composition root.

use crate::{backup, commands, profile, server_detail, sftp, ssh, sync, vault};

#[cfg(desktop)]
use crate::{drag_out, runtime};

pub(crate) fn run() {
    #[cfg(desktop)]
    desktop_run();

    // 移动端复用同一套进程内 Rust 领域。
    #[cfg(mobile)]
    {
        tauri::Builder::default()
            .plugin(tauri_plugin_deep_link::init())
            .invoke_handler(tauri::generate_handler![
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
                ssh::profile_test::profile_test_new,
                ssh::profile_test::profile_test_existing,
                ssh::profile_test::profile_confirm_host_key,
                ssh::session::session_create,
                ssh::session::session_list,
                ssh::session::session_attach,
                ssh::session::session_confirm_host_key,
                ssh::session::session_input,
                ssh::session::session_resize,
                ssh::session::session_ping,
                ssh::session::session_complete,
                ssh::session::session_close,
                sftp::sftp_create_session,
                sftp::sftp_get_session,
                sftp::sftp_list_sessions,
                sftp::sftp_close_session,
                sftp::sftp_list,
                sftp::sftp_stat,
                sftp::sftp_tree,
                sftp::sftp_mkdir,
                sftp::sftp_rename,
                sftp::sftp_delete,
                sftp::sftp_read_file,
                sftp::sftp_write_file,
                sftp::sftp_upload_begin,
                sftp::sftp_upload_chunk,
                sftp::sftp_upload_chunk_base64,
                sftp::sftp_upload_finish,
                sftp::sftp_upload_abort,
                sftp::sftp_download,
                sftp::sftp_download_chunk,
                sftp::sftp_download_chunk_base64,
                sftp::sftp_download_close,
                sftp::sftp_list_transfers,
                sftp::sftp_cancel_transfer,
                sftp::sftp_clear_completed_transfers,
                sftp::sftp_transfer,
                sftp::sftp_move,
                server_detail::server_get_info,
                server_detail::server_get_metrics,
                backup::backup_preview,
                backup::backup_import,
                sync::sync_status,
                sync::sync_backup_now,
                sync::sync_versions,
                sync::sync_restore_version,
                sync::sync_delete_version,
                sync::sync_events,
                sync::sync_get_settings,
                sync::sync_update_settings,
                sync::sync_reveal_password,
                sync::sync_shutdown,
                sync::sync_now,
                sync::sync_push,
                sync::sync_resolve_conflict,
                sync::sync_providers,
                sync::sync_create_provider,
                sync::sync_update_provider,
                sync::sync_delete_provider,
                sync::sync_test_provider,
                sync::sync_oauth_url
            ])
            .setup(|app| {
                use tauri::Manager;
                let data_dir = app.path().app_data_dir()?;
                let database = crate::infrastructure::database::Database::initialize(
                    data_dir.join("xcontrol.db"),
                )
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
                let backup = backup::BackupState::new(
                    database.clone(),
                    encryptor.clone(),
                    audit.clone(),
                    groups.clone(),
                    profiles.clone(),
                    vault.clone(),
                );
                let sync = sync::SyncState::initialize(
                    sync::store::SyncRepository::new(database.clone(), encryptor.clone()),
                    backup.clone(),
                    data_dir.join("backups"),
                )?;
                sync.start_scheduler()?;
                install_oauth_deep_links(app, &sync)?;
                let sessions =
                    ssh::SessionState::new(profiles.clone(), audit.clone(), app.handle().clone());
                let sftp =
                    sftp::SftpState::new(profiles.clone(), audit.clone(), app.handle().clone());
                app.manage(crate::snippet::SnippetService::new(database.clone()));
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
            commands::frontend_ready,
            commands::get_platform,
            commands::read_app_log,
            commands::append_frontend_log,
            commands::clear_app_log,
            commands::migrate_electron_settings,
            commands::mark_electron_settings_migrated,
            commands::save_blob_to_disk,
            backup::backup_pick_file,
            backup::backup_export,
            backup::backup_preview,
            backup::backup_import,
            drag_out::sftp_drag_out,
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
            ssh::profile_test::profile_test_new,
            ssh::profile_test::profile_test_existing,
            ssh::profile_test::profile_confirm_host_key,
            ssh::session::session_create,
            ssh::session::session_list,
            ssh::session::session_attach,
            ssh::session::session_confirm_host_key,
            ssh::session::session_input,
            ssh::session::session_resize,
            ssh::session::session_ping,
            ssh::session::session_complete,
            ssh::session::session_close,
            sftp::sftp_create_session,
            sftp::sftp_get_session,
            sftp::sftp_list_sessions,
            sftp::sftp_close_session,
            sftp::sftp_list,
            sftp::sftp_stat,
            sftp::sftp_tree,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_delete,
            sftp::sftp_read_file,
            sftp::sftp_write_file,
            sftp::sftp_upload_begin,
            sftp::sftp_upload_chunk,
            sftp::sftp_upload_chunk_base64,
            sftp::sftp_upload_finish,
            sftp::sftp_upload_abort,
            sftp::sftp_download,
            sftp::sftp_download_chunk,
            sftp::sftp_download_chunk_base64,
            sftp::sftp_download_close,
            sftp::sftp_list_transfers,
            sftp::sftp_cancel_transfer,
            sftp::sftp_clear_completed_transfers,
            sftp::sftp_transfer,
            sftp::sftp_move,
            server_detail::server_get_info,
            server_detail::server_get_metrics,
            sync::sync_status,
            sync::sync_backup_now,
            sync::sync_versions,
            sync::sync_restore_version,
            sync::sync_delete_version,
            sync::sync_events,
            sync::sync_get_settings,
            sync::sync_update_settings,
            sync::sync_reveal_password,
            sync::sync_shutdown,
            sync::sync_now,
            sync::sync_push,
            sync::sync_resolve_conflict,
            sync::sync_providers,
            sync::sync_create_provider,
            sync::sync_update_provider,
            sync::sync_delete_provider,
            sync::sync_test_provider,
            sync::sync_oauth_url
        ])
        .setup(move |app| {
            let data_dir = runtime::user_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let database =
                crate::infrastructure::database::Database::initialize(data_dir.join("xcontrol.db"))
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
            let backup = backup::BackupState::new(
                database.clone(),
                encryptor.clone(),
                audit.clone(),
                groups.clone(),
                profiles.clone(),
                vault.clone(),
            );
            let sync = sync::SyncState::initialize(
                sync::store::SyncRepository::new(database.clone(), encryptor.clone()),
                backup.clone(),
                data_dir.join("backups"),
            )?;
            sync.start_scheduler()?;
            install_oauth_deep_links(app, &sync)?;
            let sessions =
                ssh::SessionState::new(profiles.clone(), audit.clone(), app.handle().clone());
            let sftp = sftp::SftpState::new(profiles.clone(), audit.clone(), app.handle().clone());
            app.manage(crate::snippet::SnippetService::new(database.clone()));
            app.manage(groups);
            app.manage(vault);
            app.manage(profiles);
            app.manage(backup);
            app.manage(sync);
            app.manage(sessions);
            app.manage(sftp);
            app.manage(audit);
            drag_out::sweep_stale_drag_temps();
            if smoke {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    if let Some(path) = std::env::var_os("XCONTROL_SMOKE_MARKER_PATH") {
                        let _ = std::fs::write(path, "XCONTROL_TAURI_SMOKE_OK\n");
                    }
                    println!("XCONTROL_TAURI_SMOKE_OK");
                    handle.exit(0);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let sync = app_handle.state::<sync::SyncState>().inner().clone();
                let sessions = app_handle.state::<ssh::SessionState>().inner().clone();
                let sftp = app_handle.state::<sftp::SftpState>().inner().clone();
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
    sync: &sync::SyncState,
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
            if !raw.starts_with("xcontrol://oauth/") {
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
            if raw.starts_with("xcontrol://oauth/") {
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
