//! xcontrol-server sidecar 生命周期管理（对齐 Electron main.js，见迁移方案 §5.2/§5.3）。
//!
//! 职责：
//! 1. 从主窗口 URL 推导 webview origin（dev 为 Vite devUrl，打包后为平台自定义协议），
//!    作为后端 CORS / WebSocket Origin 校验的放行名单
//! 2. 申请空闲回环端口 + 生成 256bit 随机访问令牌
//! 3. 以环境变量注入配置 spawn sidecar，stdio 追加到用户数据目录 logs/backend.log
//! 4. 轮询 /api/health 直到就绪
//! 5. 退出时 POST /api/shutdown（Bearer）→ 等待 ≤5s → 强杀

use std::{
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::http;

/// smoke 测试通过时打印的标记（CI 断言用，等价 XCONTROL_ELECTRON_SMOKE_OK）。
pub const SMOKE_OK_MARKER: &str = "XCONTROL_TAURI_SMOKE_OK";

/// 前端连接后端所需的最小信息。
#[derive(Clone, Serialize)]
pub struct BackendInfo {
    pub port: u16,
    pub token: String,
}

/// 运行期信息（供 smoke 检查与优雅退出复用）。
struct Runtime {
    info: BackendInfo,
    origin: String,
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();
static CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn child_slot() -> &'static Mutex<Option<Child>> {
    CHILD.get_or_init(|| Mutex::new(None))
}

/// 前端可见的后端状态：None=启动中，Some(Ok)=就绪，Some(Err)=失败。
#[derive(Clone, Default)]
pub struct BackendState {
    inner: Arc<Mutex<Option<Result<BackendInfo, String>>>>,
}

impl BackendState {
    pub fn new() -> Self {
        Self::default()
    }

    fn set(&self, value: Result<BackendInfo, String>) {
        *self.inner.lock().unwrap() = Some(value);
    }

    pub fn get(&self) -> Option<Result<BackendInfo, String>> {
        self.inner.lock().unwrap().clone()
    }
}

/// 异常退出兜底：Drop 时强杀仍存活的 sidecar。
/// 正常退出路径已由 `shutdown_current` 取走子进程，这里只覆盖崩溃/panic 等路径。
pub struct ExitGuard;

impl Drop for ExitGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = child_slot().lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// spawn 阶段的产物（跨线程传递给 orchestrate 做健康轮询）。
pub struct SpawnedBackend {
    info: BackendInfo,
    origin: String,
    log_path: PathBuf,
}

/// 启动编排入口（在工作线程中调用，接收主线程 spawn 的结果做健康轮询）。
pub fn orchestrate(
    app: &AppHandle,
    state: BackendState,
    spawned: Result<SpawnedBackend, String>,
    smoke: bool,
) {
    // 启动清扫 24h 以上的拖出临时目录（对应 Electron sweepNativeDragTemps）
    crate::drag_out::sweep_stale_drag_temps();

    let sp = match spawned {
        Ok(sp) => sp,
        Err(err) => {
            eprintln!("[backend] 启动失败: {err}");
            state.set(Err(err));
            if smoke {
                shutdown_current();
                std::process::exit(1);
            }
            return;
        }
    };

    match wait_until_healthy(&sp) {
        Ok(()) => {
            let _ = RUNTIME.set(Runtime {
                info: sp.info.clone(),
                origin: sp.origin,
            });
            state.set(Ok(sp.info.clone()));
            if smoke {
                match run_smoke_checks(&sp.info) {
                    Ok(()) => {
                        shutdown_current();
                        println!("{SMOKE_OK_MARKER}");
                        app.exit(0);
                    }
                    Err(err) => {
                        eprintln!("[smoke] 失败: {err}");
                        shutdown_current();
                        std::process::exit(1);
                    }
                }
            }
        }
        Err(err) => {
            eprintln!("[backend] 启动失败: {err}");
            state.set(Err(err));
            if smoke {
                shutdown_current();
                std::process::exit(1);
            }
        }
    }
}

/// spawn sidecar：必须在**主线程**（Tauri 事件循环线程）调用。
///
/// 原因：Linux 下 PR_SET_PDEATHSIG 的语义是「父**线程**死亡时发信号」，
/// 若在工作线程 spawn，该线程结束（健康检查完成后即返回）就会误杀 sidecar；
/// 主线程存活于整个应用生命周期，正好匹配。
pub fn spawn_backend(app: &AppHandle) -> Result<SpawnedBackend, Box<dyn std::error::Error>> {
    // 1. webview origin（决定后端 CORS / WS 放行名单，方案 §5.2）
    let origin = webview_origin(app)?;

    // 2. 空闲端口 + 256bit 随机 token
    let port = pick_free_port()?;
    let token = generate_token()?;

    // 3. 用户数据目录（复用 Electron 时代路径，实现无感迁移，方案 §9.1）
    let data_dir = user_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    let logs_dir = data_dir.join("logs");
    std::fs::create_dir_all(&logs_dir)?;
    let log_path = logs_dir.join("backend.log");

    // 4. spawn（stdio 追加重定向到日志文件；Windows 隐藏控制台窗口）
    let exe = backend_executable()?;
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let log_err = log_file.try_clone()?;
    let mut cmd = Command::new(&exe);
    cmd.env("XCONTROL_PORT", port.to_string())
        .env("XCONTROL_HOST", "127.0.0.1")
        .env("XCONTROL_DB_PATH", data_dir.join("xcontrol.db"))
        .env("XCONTROL_KEY_PATH", data_dir.join("key"))
        .env("XCONTROL_LOG_LEVEL", "info")
        .env("XCONTROL_ACCESS_TOKEN", &token)
        .env("XCONTROL_ALLOWED_ORIGINS", &origin)
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_err));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        // 父进程（无论以何种方式退出，含 SIGKILL）死亡时，内核向 sidecar 发送
        // SIGTERM，Go 侧按正常信号路径优雅关闭 —— 兜底所有 Rust 侧清理逻辑
        // 来不及执行的场景（如被 timeout/SIGKILL 强杀）。
        // SAFETY: pre_exec 在 fork 与 exec 之间的子进程上下文执行，
        // prctl 为原始 syscall，async-signal-safe。
        unsafe {
            cmd.pre_exec(|| {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let child = cmd.spawn()?;
    *child_slot().lock().unwrap() = Some(child);

    Ok(SpawnedBackend {
        info: BackendInfo { port, token },
        origin,
        log_path,
    })
}

/// 健康轮询（200ms × 15s；子进程提前退出则立即失败）。
fn wait_until_healthy(sp: &SpawnedBackend) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(response) = http::request(sp.info.port, "GET", "/api/health", None, None, None) {
            if response.status == 204 {
                return Ok(());
            }
        }
        if let Ok(mut slot) = child_slot().try_lock() {
            if let Some(child) = slot.as_mut() {
                if child.try_wait().ok().flatten().is_some() {
                    *slot = None;
                    return Err(format!(
                        "后端进程提前退出，请查看日志：{}",
                        sp.log_path.display()
                    ));
                }
            }
        }
        if Instant::now() > deadline {
            return Err(format!(
                "后端启动超时（15s），请查看日志：{}",
                sp.log_path.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// 当前后端连接信息（端口 + 令牌）；后端未就绪时为 None。
/// 供保存文件等命令直接访问 sidecar（方案 §5.5 save_url_to_disk）。
pub fn current_info() -> Option<BackendInfo> {
    RUNTIME.get().map(|runtime| runtime.info.clone())
}

/// 停止后端：POST /api/shutdown（Bearer）→ 等待 ≤5s → 强杀。幂等，可安全重复调用。
pub fn shutdown_current() {
    let mut slot = child_slot().lock().unwrap();
    let Some(mut child) = slot.take() else {
        return;
    };
    drop(slot);

    if let Some(runtime) = RUNTIME.get() {
        let _ = http::request(
            runtime.info.port,
            "POST",
            "/api/shutdown",
            Some(&runtime.info.token),
            None,
            None,
        );
    }

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Rust 侧 smoke 检查（比 Electron 版更严格，见方案 §5.7）：
/// 健康检查、无 token 拒绝、带 token 放行、CORS 放行 webview origin。
fn run_smoke_checks(info: &BackendInfo) -> Result<(), String> {
    let origin = RUNTIME
        .get()
        .map(|runtime| runtime.origin.clone())
        .ok_or_else(|| "运行期信息缺失".to_string())?;

    let response = http::request(info.port, "GET", "/api/health", None, None, None)
        .map_err(|err| format!("health 请求失败: {err}"))?;
    if response.status != 204 {
        return Err(format!("health 期望 204，实际 {}", response.status));
    }

    let response = http::request(info.port, "GET", "/api/groups", None, None, None)
        .map_err(|err| format!("无鉴权请求失败: {err}"))?;
    if response.status != 401 {
        return Err(format!("无 token 期望 401，实际 {}", response.status));
    }

    let response = http::request(
        info.port,
        "GET",
        "/api/groups",
        Some(&info.token),
        Some(&origin),
        None,
    )
    .map_err(|err| format!("鉴权请求失败: {err}"))?;
    if response.status != 200 {
        return Err(format!("带 token 期望 200，实际 {}", response.status));
    }
    match response.header("access-control-allow-origin") {
        Some(allowed) if allowed == origin => Ok(()),
        other => Err(format!("CORS 响应异常: {other:?}")),
    }
}

/// 从主窗口 URL 推导 origin（scheme://host[:port]）。
/// dev: http://localhost:5173；prod: Windows http://tauri.localhost、macOS tauri://localhost、
/// Linux 由 webkitgtk 决定 —— 运行时推导避免了硬编码平台差异。
fn webview_origin(app: &AppHandle) -> Result<String, Box<dyn std::error::Error>> {
    let url = app
        .get_webview_window("main")
        .ok_or("未找到主窗口")?
        .url()?;
    let mut origin = format!(
        "{}://{}",
        url.scheme(),
        url.host_str().unwrap_or("localhost")
    );
    if let Some(port) = url.port() {
        origin.push_str(&format!(":{port}"));
    }
    Ok(origin)
}

/// Electron 时代 userData 目录（数据库/密钥/日志所在，实现无感迁移，方案 §9.1）。
/// 与 Electron app.getPath('userData') 的跨平台对齐：
/// Windows: %APPDATA%\XControl；macOS: ~/Library/Application Support/XControl；
/// Linux: ~/.config/XControl —— 注意 Linux 上 Electron 用 XDG config 而非 data，
/// 因此 Linux 取 dirs::config_dir()，其余平台取 dirs::data_dir()。
pub fn user_data_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let base = if cfg!(target_os = "linux") {
        dirs::config_dir()
    } else {
        dirs::data_dir()
    }
    .ok_or("无法确定系统数据目录")?;
    Ok(base.join("XControl"))
}

/// sidecar 可执行文件路径：
/// - 打包模式：externalBin 的源文件带 target-triple 后缀，但 Tauri 在复制到
///   主程序同目录时会移除该后缀，因此运行时文件名固定为 xcontrol-server[.exe]
///   （Windows 安装目录、macOS Contents/MacOS、Linux /usr/bin / AppImage usr/bin）
/// - 开发模式：XCONTROL_SERVER_PATH 环境变量，或仓库内 server/ 构建产物
///   （CARGO_MANIFEST_DIR 编译期确定，不依赖运行时 cwd）
fn backend_executable() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let exe_suffix = std::env::consts::EXE_SUFFIX;
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("XCONTROL_SERVER_PATH") {
            let path = PathBuf::from(path);
            if path.exists() {
                return Ok(path);
            }
            return Err(format!("XCONTROL_SERVER_PATH 不存在: {}", path.display()).into());
        }
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../server/xcontrol-server{exe_suffix}"));
        if !path.exists() {
            return Err(
                "未找到后端二进制，请先执行 scripts/prepare-sidecar.mjs（或 npm run desktop:dev）\
                 或设置 XCONTROL_SERVER_PATH"
                    .into(),
            );
        }
        return Ok(path);
    }
    let path = bundled_backend_path(&std::env::current_exe()?)?;
    if !path.exists() {
        return Err(format!("未找到打包的后端二进制: {}", path.display()).into());
    }
    Ok(path)
}

fn bundled_backend_path(app_executable: &Path) -> Result<PathBuf, &'static str> {
    let app_dir = app_executable
        .parent()
        .ok_or("无法确定桌面主程序目录")?;
    Ok(app_dir.join(bundled_backend_filename()))
}

fn bundled_backend_filename() -> String {
    format!("xcontrol-server{}", std::env::consts::EXE_SUFFIX)
}

/// 申请一个空闲回环端口（bind :0 后释放，与 Electron pickFreePort 一致）。
fn pick_free_port() -> Result<u16, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

/// 生成 256bit 随机访问令牌（hex 编码，URL 安全，可直接用于 Bearer 头与 query 参数）。
fn generate_token() -> Result<String, Box<dyn std::error::Error>> {
    let mut buf = [0u8; 32];
    // getrandom 0.3 的 Error 未实现 StdError（no_std 兼容），手动转成字符串错误
    getrandom::fill(&mut buf).map_err(|err| format!("随机数生成失败: {err}"))?;
    Ok(buf.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_backend_filename_omits_target_triple() {
        let filename = bundled_backend_filename();
        assert_eq!(
            filename,
            format!("xcontrol-server{}", std::env::consts::EXE_SUFFIX)
        );
        assert!(!filename.contains(std::env::consts::ARCH));
    }

    #[test]
    fn bundled_backend_is_next_to_main_executable() {
        let app = Path::new("/Applications/XControl.app/Contents/MacOS/XControl");
        let sidecar = bundled_backend_path(app).unwrap();
        assert_eq!(
            sidecar,
            app.parent().unwrap().join(bundled_backend_filename())
        );
    }

    #[test]
    fn user_data_dir_reuses_electron_layout() {
        let dir = user_data_dir().unwrap();
        assert!(dir.ends_with("XControl"));
    }

    #[test]
    fn backend_state_transitions() {
        let state = BackendState::new();
        assert!(state.get().is_none());
        state.set(Err("boom".into()));
        assert!(matches!(state.get(), Some(Err(err)) if err == "boom"));
        state.set(Ok(BackendInfo {
            port: 1,
            token: "t".into(),
        }));
        assert!(matches!(state.get(), Some(Ok(info)) if info.port == 1));
    }
}
