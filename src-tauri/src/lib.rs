//! XControl 桌面壳（Tauri 2）。
//!
//! 架构与职责见 `docs/TAURI_MIGRATION.md`：
//! - sidecar 生命周期：`backend.rs`（选端口/生成 token/spawn/健康轮询/优雅退出）
//! - IPC 命令：`commands.rs`（get_backend_info / frontend_ready / get_platform / 设置迁移）
//! - 桌面逻辑全部 `#[cfg(desktop)]` 门控，为移动端预留（方案 §14）。

#[cfg(desktop)]
mod backend;
#[cfg(desktop)]
mod commands;
#[cfg(desktop)]
mod drag_out;
#[cfg(desktop)]
mod http;
#[cfg(desktop)]
mod settings_migrate;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    desktop_run();

    // 移动端暂未实现（方案 §14：sidecar 子进程在移动端不可用，
    // 需 Go 进程内嵌入 gomobile 或薄客户端模式，届时在此分支接入）。
    #[cfg(mobile)]
    {
        tauri::Builder::default()
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    }
}

#[cfg(desktop)]
fn desktop_run() {
    use tauri::Manager;

    let smoke = std::env::args().any(|arg| arg == "--smoke-test");

    // 异常退出兜底（等价 Electron process.on('exit') → forceKillBackend）：
    // 正常退出路径已由 RunEvent::ExitRequested 中的 shutdown_current 处理。
    let _exit_guard = backend::ExitGuard;

    tauri::Builder::default()
        // 单实例锁：二次启动聚焦已有窗口（等价 Electron requestSingleInstanceLock）
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // 外部链接走系统默认浏览器（等价 Electron shell.openExternal + setWindowOpenHandler）
        .plugin(tauri_plugin_opener::init())
        // 保存文件对话框（save_url_to_disk / save_blob_to_disk 命令的 Rust 侧 API）
        .plugin(tauri_plugin_dialog::init())
        // 文件拖出到系统（sftp_drag_out 物化后由前端 startDrag 接管）
        .plugin(tauri_plugin_drag::init())
        // 应用内更新（stable 通道）+ 更新后重启（方案 §8.2）
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_backend_info,
            commands::frontend_ready,
            commands::get_platform,
            commands::migrate_electron_settings,
            commands::save_url_to_disk,
            commands::save_blob_to_disk,
            drag_out::sftp_drag_out
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = backend::BackendState::new();
            app.manage(state.clone());
            // spawn 必须在主线程执行（PR_SET_PDEATHSIG 绑定父线程，见 backend.rs），
            // 健康轮询/smoke 检查放独立线程不阻塞 setup；
            // 前端通过 get_backend_info 阻塞等待就绪（方案 §5.2）。
            let spawned = backend::spawn_backend(app.handle()).map_err(|err| err.to_string());
            std::thread::spawn(move || backend::orchestrate(&handle, state, spawned, smoke));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // 优雅退出：POST /api/shutdown → 等待 ≤5s → 强杀（等价 Electron before-quit，方案 §5.3）
            if let tauri::RunEvent::ExitRequested { .. } = event {
                backend::shutdown_current();
            }
        });
}
