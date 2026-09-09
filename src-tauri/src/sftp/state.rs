use std::{
    collections::HashMap, future::Future, path::Path, pin::Pin, sync::Arc, time::SystemTime,
};

use chrono::{DateTime, Local, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;

#[cfg(test)]
use super::backend::join_path;
use super::backend::{base_name, clean_path, format_time, local_home_dir, FileBackend, FileInfo};
use super::transfer::TransferManager;
use crate::{
    audit::AuditRepository,
    error::CommandError,
    profile::ProfileService,
    ssh::transport::{connect_route, HostKeyVerifier},
};

const MAX_EDITABLE_FILE_SIZE: usize = 10 * 1024 * 1024;
const BINARY_SNIFF_SIZE: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct SftpSessionInfo {
    id: String,
    profile_id: String,
    status: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    error: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    home_dir: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
pub struct SftpCreateSessionResponse {
    session_id: String,
    status: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    home_dir: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SftpEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    mod_time: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    mode: String,
}

#[derive(Debug, Serialize)]
pub struct SftpTreeNode {
    #[serde(flatten)]
    entry: SftpEntry,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    children: Vec<SftpTreeNode>,
}

#[derive(Debug, Serialize)]
pub struct SftpListResponse {
    path: String,
    entries: Vec<SftpEntry>,
}

#[derive(Debug, Serialize)]
pub struct SftpTreeResponse {
    path: String,
    entries: Vec<SftpTreeNode>,
}

#[derive(Debug, Serialize)]
pub struct SftpDeleteResponse {
    deleted: usize,
    failed: usize,
}

#[derive(Debug, Serialize)]
pub struct SftpFileReadResponse {
    path: String,
    content: String,
    size: u64,
    mod_time: String,
    language: String,
    line_ending: String,
    read_only: bool,
}

#[derive(Debug, Deserialize)]
pub struct SftpFileWriteRequest {
    content: String,
    #[serde(default)]
    expected_mod_time: String,
    #[serde(default)]
    line_ending: String,
}

#[derive(Debug, Serialize)]
pub struct SftpFileWriteResponse {
    path: String,
    size: u64,
    mod_time: String,
}

#[derive(Debug, Clone, Serialize)]
struct SftpEvent {
    #[serde(rename = "type")]
    event_type: &'static str,
    payload: serde_json::Value,
}

struct SessionData {
    status: String,
    error: String,
    home_dir: String,
    backend: Option<Arc<FileBackend>>,
}

pub(super) struct SftpSession {
    pub(super) id: String,
    pub(super) profile_id: String,
    created_at: String,
    data: RwLock<SessionData>,
}

#[derive(Clone)]
pub struct SftpState {
    pub(super) sessions: Arc<RwLock<HashMap<String, Arc<SftpSession>>>>,
    pub(super) profiles: ProfileService,
    pub(super) audit: AuditRepository,
    pub(super) app: AppHandle,
    pub(super) transfers: TransferManager,
}

struct StrictHostKeyVerifier;

impl HostKeyVerifier for StrictHostKeyVerifier {
    fn verify<'a>(
        &'a self,
        _profile_id: &'a str,
        _profile_name: &'a str,
        known: &'a str,
        current: &'a str,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move { known.is_empty() || known == current })
    }
}

impl SftpState {
    pub fn new(profiles: ProfileService, audit: AuditRepository, app: AppHandle) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            profiles,
            audit,
            app,
            transfers: TransferManager::new(),
        }
    }

    async fn create_session(
        &self,
        profile_id: String,
    ) -> Result<SftpCreateSessionResponse, CommandError> {
        if profile_id.is_empty() {
            return Err(CommandError::new("VALIDATION", "profile_id is required"));
        }
        if profile_id != "local" {
            self.profiles.resolve_connection(&profile_id)?;
        }

        let session = Arc::new(SftpSession {
            id: uuid::Uuid::new_v4().to_string(),
            profile_id: profile_id.clone(),
            created_at: Local::now().to_rfc3339_opts(SecondsFormat::AutoSi, true),
            data: RwLock::new(SessionData {
                status: "connecting".into(),
                error: String::new(),
                home_dir: String::new(),
                backend: None,
            }),
        });
        self.sessions
            .write()
            .await
            .insert(session.id.clone(), session.clone());

        if profile_id == "local" {
            let home_dir = local_home_dir();
            let mut data = session.data.write().await;
            data.status = "connected".into();
            data.home_dir = home_dir.clone();
            data.backend = Some(Arc::new(FileBackend::Local));
            drop(data);
            self.emit_session_status(&session.id, "connected");
            return Ok(SftpCreateSessionResponse {
                session_id: session.id.clone(),
                status: "connected".into(),
                home_dir,
            });
        }

        let state = self.clone();
        let session_for_task = session.clone();
        tauri::async_runtime::spawn(async move {
            state.connect_remote(session_for_task).await;
        });
        Ok(SftpCreateSessionResponse {
            session_id: session.id.clone(),
            status: "connecting".into(),
            home_dir: String::new(),
        })
    }

    async fn connect_remote(&self, session: Arc<SftpSession>) {
        let result = async {
            let resolved = self.profiles.resolve_connection(&session.profile_id)?;
            let route = connect_route(resolved, Arc::new(StrictHostKeyVerifier))
                .await
                .map_err(|error| CommandError::new("SFTP_CONNECT_FAILED", error))?;
            let channel = route
                .handle
                .channel_open_session()
                .await
                .map_err(|error| CommandError::new("SFTP_CONNECT_FAILED", error.to_string()))?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|error| CommandError::new("SFTP_CONNECT_FAILED", error.to_string()))?;
            let sftp = Arc::new(
                russh_sftp::client::SftpSession::new(channel.into_stream())
                    .await
                    .map_err(|error| CommandError::new("SFTP_CONNECT_FAILED", error.to_string()))?,
            );
            let home_dir = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());
            Ok::<_, CommandError>((route, sftp, clean_path(&home_dir)))
        }
        .await;

        match result {
            Ok((route, sftp, home_dir)) => {
                for (profile_id, fingerprint) in &route.host_keys {
                    if let Err(error) = self.profiles.persist_host_key(profile_id, fingerprint) {
                        eprintln!("persist SFTP host key failed: {error}");
                    }
                }
                let backend = Arc::new(FileBackend::Remote {
                    sftp,
                    _route: route,
                });
                let is_active = self
                    .sessions
                    .read()
                    .await
                    .get(&session.id)
                    .is_some_and(|current| Arc::ptr_eq(current, &session));
                if !is_active {
                    backend.close().await;
                    return;
                }
                {
                    let mut data = session.data.write().await;
                    data.status = "connected".into();
                    data.home_dir = home_dir;
                    data.backend = Some(backend);
                }
                let _ = self.profiles.update_last_used(&session.profile_id);
                let _ = self.audit.record(&session.profile_id, "sftp_connect", "");
                self.emit_session_status(&session.id, "connected");
            }
            Err(error) => {
                let mut data = session.data.write().await;
                data.status = "disconnected".into();
                data.error = format!("连接失败: {}", error.message);
                drop(data);
                self.emit_session_status(&session.id, "disconnected");
            }
        }
    }

    fn emit_session_status(&self, session_id: &str, status: &str) {
        let _ = self.app.emit(
            "xcontrol-sftp-message",
            SftpEvent {
                event_type: "sftp_session_status",
                payload: serde_json::json!({"session_id":session_id,"status":status}),
            },
        );
    }

    pub(super) async fn session(&self, id: &str) -> Result<Arc<SftpSession>, CommandError> {
        self.sessions
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| CommandError::new("NOT_FOUND", "session not found"))
    }

    pub(super) async fn backend(
        &self,
        id: &str,
    ) -> Result<(Arc<SftpSession>, Arc<FileBackend>), CommandError> {
        let session = self.session(id).await?;
        let data = session.data.read().await;
        let backend = data.backend.clone().ok_or_else(|| {
            CommandError::new(
                "SESSION_NOT_CONNECTED",
                if data.error.is_empty() {
                    format!("session is {}", data.status)
                } else {
                    data.error.clone()
                },
            )
        })?;
        drop(data);
        Ok((session, backend))
    }

    async fn info(session: &SftpSession) -> SftpSessionInfo {
        let data = session.data.read().await;
        SftpSessionInfo {
            id: session.id.clone(),
            profile_id: session.profile_id.clone(),
            status: data.status.clone(),
            error: data.error.clone(),
            home_dir: data.home_dir.clone(),
            created_at: session.created_at.clone(),
        }
    }

    pub async fn shutdown(&self) {
        let sessions = self
            .sessions
            .write()
            .await
            .drain()
            .map(|(_, value)| value)
            .collect::<Vec<_>>();
        for session in sessions {
            if let Some(backend) = session.data.write().await.backend.take() {
                backend.close().await;
            }
        }
        self.transfers.shutdown().await;
    }

    pub(crate) async fn exec(
        &self,
        session_id: &str,
        command: &str,
    ) -> Result<(String, i32), CommandError> {
        let (_, backend) = self.backend(session_id).await?;
        backend
            .exec(command)
            .await
            .map_err(|error| CommandError::new("EXEC_FAILED", error))
    }
}

fn entry(info: FileInfo) -> SftpEntry {
    SftpEntry {
        name: info.name,
        path: info.path,
        is_dir: info.is_dir,
        size: info.size,
        mod_time: format_time(info.modified),
        mode: info.mode,
    }
}

fn tree<'a>(
    backend: &'a FileBackend,
    path: &'a str,
    depth: u32,
) -> Pin<Box<dyn Future<Output = Result<Vec<SftpTreeNode>, String>> + Send + 'a>> {
    Box::pin(async move {
        let mut nodes = Vec::new();
        for info in backend.list(path).await? {
            let children = if info.is_dir && depth > 1 {
                tree(backend, &info.path, depth - 1).await?
            } else {
                Vec::new()
            };
            nodes.push(SftpTreeNode {
                entry: entry(info),
                children,
            });
        }
        nodes.sort_by(|left, right| {
            right.entry.is_dir.cmp(&left.entry.is_dir).then_with(|| {
                left.entry
                    .name
                    .to_lowercase()
                    .cmp(&right.entry.name.to_lowercase())
            })
        });
        Ok(nodes)
    })
}

fn remove_all<'a>(
    backend: &'a FileBackend,
    path: &'a str,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let info = backend.stat(path).await?;
        if !info.is_dir {
            return backend.remove_file(path).await;
        }
        for child in backend.list(path).await? {
            remove_all(backend, &child.path).await?;
        }
        backend.remove_dir(path).await
    })
}

fn backend_error(error: String) -> CommandError {
    let lower = error.to_lowercase();
    let code = if lower.contains("not found") || lower.contains("no such") {
        "NOT_FOUND"
    } else if lower.contains("permission") || lower.contains("denied") {
        "PERMISSION_DENIED"
    } else if lower.contains("exist") {
        "PATH_EXISTS"
    } else {
        "INTERNAL"
    };
    CommandError::new(code, error)
}

#[tauri::command]
pub async fn sftp_create_session(
    state: State<'_, SftpState>,
    profile_id: String,
) -> Result<SftpCreateSessionResponse, CommandError> {
    state.create_session(profile_id).await
}

#[tauri::command]
pub async fn sftp_get_session(
    state: State<'_, SftpState>,
    id: String,
) -> Result<SftpSessionInfo, CommandError> {
    let session = state.session(&id).await?;
    Ok(SftpState::info(&session).await)
}

#[tauri::command]
pub async fn sftp_list_sessions(
    state: State<'_, SftpState>,
) -> Result<Vec<SftpSessionInfo>, CommandError> {
    let sessions = state
        .sessions
        .read()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let mut result = Vec::with_capacity(sessions.len());
    for session in sessions {
        result.push(SftpState::info(&session).await);
    }
    Ok(result)
}

#[tauri::command]
pub async fn sftp_close_session(
    state: State<'_, SftpState>,
    id: String,
) -> Result<(), CommandError> {
    let session = state
        .sessions
        .write()
        .await
        .remove(&id)
        .ok_or_else(|| CommandError::new("NOT_FOUND", "session not found"))?;
    state.transfers.cancel_session(&id).await;
    if let Some(backend) = session.data.write().await.backend.take() {
        backend.close().await;
    }
    let _ = state
        .audit
        .record(&session.profile_id, "sftp_disconnect", "");
    Ok(())
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, SftpState>,
    session_id: String,
    path: String,
    show_hidden: Option<bool>,
) -> Result<SftpListResponse, CommandError> {
    if path.is_empty() {
        return Err(CommandError::new("VALIDATION", "path is required"));
    }
    let (_, backend) = state.backend(&session_id).await?;
    let path = clean_path(&path);
    let mut entries = backend.list(&path).await.map_err(backend_error)?;
    if !show_hidden.unwrap_or(false) {
        entries.retain(|value| !value.name.starts_with('.'));
    }
    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(SftpListResponse {
        path,
        entries: entries.into_iter().map(entry).collect(),
    })
}

#[tauri::command]
pub async fn sftp_stat(
    state: State<'_, SftpState>,
    session_id: String,
    path: String,
) -> Result<SftpEntry, CommandError> {
    let (_, backend) = state.backend(&session_id).await?;
    backend
        .stat(&clean_path(&path))
        .await
        .map(entry)
        .map_err(backend_error)
}

#[tauri::command]
pub async fn sftp_tree(
    state: State<'_, SftpState>,
    session_id: String,
    path: String,
    depth: Option<u32>,
) -> Result<SftpTreeResponse, CommandError> {
    let (_, backend) = state.backend(&session_id).await?;
    let path = clean_path(&path);
    let entries = tree(&backend, &path, depth.unwrap_or(3).max(1))
        .await
        .map_err(backend_error)?;
    Ok(SftpTreeResponse { path, entries })
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, SftpState>,
    session_id: String,
    path: String,
) -> Result<SftpEntry, CommandError> {
    let (session, backend) = state.backend(&session_id).await?;
    let path = clean_path(&path);
    backend.mkdir(&path).await.map_err(backend_error)?;
    let result = backend.stat(&path).await.map(entry).unwrap_or(SftpEntry {
        name: base_name(&path),
        path: path.clone(),
        is_dir: true,
        size: 0,
        mod_time: format_time(SystemTime::now()),
        mode: String::new(),
    });
    let _ = state
        .audit
        .record(&session.profile_id, "sftp_mkdir", format!("path={path}"));
    Ok(result)
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, SftpState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<SftpEntry, CommandError> {
    let (session, backend) = state.backend(&session_id).await?;
    let old_path = clean_path(&old_path);
    let new_path = clean_path(&new_path);
    backend
        .rename(&old_path, &new_path)
        .await
        .map_err(backend_error)?;
    let result = backend
        .stat(&new_path)
        .await
        .map(entry)
        .map_err(backend_error)?;
    let _ = state.audit.record(
        &session.profile_id,
        "sftp_rename",
        format!("old={old_path} new={new_path}"),
    );
    Ok(result)
}

#[tauri::command]
pub async fn sftp_delete(
    state: State<'_, SftpState>,
    session_id: String,
    paths: Vec<String>,
) -> Result<SftpDeleteResponse, CommandError> {
    if paths.is_empty() {
        return Err(CommandError::new("VALIDATION", "paths is required"));
    }
    let (session, backend) = state.backend(&session_id).await?;
    let mut deleted = 0;
    let mut failed = 0;
    for path in &paths {
        if remove_all(&backend, &clean_path(path)).await.is_ok() {
            deleted += 1;
        } else {
            failed += 1;
        }
    }
    let _ = state.audit.record(
        &session.profile_id,
        "sftp_delete",
        format!("paths={}", paths.join("/")),
    );
    Ok(SftpDeleteResponse { deleted, failed })
}

#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, SftpState>,
    session_id: String,
    path: String,
) -> Result<SftpFileReadResponse, CommandError> {
    let (session, backend) = state.backend(&session_id).await?;
    let path = clean_path(&path);
    let info = backend.stat(&path).await.map_err(backend_error)?;
    if info.is_dir {
        return Err(CommandError::new("IS_DIRECTORY", "cannot edit a directory"));
    }
    if info.size > MAX_EDITABLE_FILE_SIZE as u64 {
        return Err(CommandError::new(
            "FILE_TOO_LARGE",
            "文件过大，无法在编辑器中打开（上限 10MB），请下载后本地编辑",
        ));
    }
    let bytes = backend
        .read(&path, Some(MAX_EDITABLE_FILE_SIZE))
        .await
        .map_err(backend_error)?;
    if bytes.len() > MAX_EDITABLE_FILE_SIZE {
        return Err(CommandError::new(
            "FILE_TOO_LARGE",
            "文件在读取过程中变大超过 10MB 上限",
        ));
    }
    if bytes[..bytes.len().min(BINARY_SNIFF_SIZE)].contains(&0) {
        return Err(CommandError::new(
            "BINARY_FILE",
            "该文件为二进制文件，无法在文本编辑器中打开",
        ));
    }
    let mut content = String::from_utf8(bytes).map_err(|_| {
        CommandError::new(
            "UNSUPPORTED_ENCODING",
            "文件不是有效的 UTF-8 编码（当前仅支持 UTF-8）",
        )
    })?;
    let line_ending = detect_line_ending(content.as_bytes());
    if line_ending == "crlf" {
        content = content.replace("\r\n", "\n");
    }
    let _ = state.audit.record(
        &session.profile_id,
        "sftp_read_file",
        format!("path={path}"),
    );
    Ok(SftpFileReadResponse {
        path: path.clone(),
        content,
        size: info.size,
        mod_time: format_time(info.modified),
        language: detect_language(&path),
        line_ending: line_ending.into(),
        read_only: !is_writable(&info.mode),
    })
}

#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, SftpState>,
    session_id: String,
    path: String,
    request: SftpFileWriteRequest,
) -> Result<SftpFileWriteResponse, CommandError> {
    let (session, backend) = state.backend(&session_id).await?;
    let path = clean_path(&path);
    let existing = backend.stat(&path).await.ok();
    if let Some(info) = &existing {
        if info.is_dir {
            return Err(CommandError::new(
                "IS_DIRECTORY",
                "cannot write a directory",
            ));
        }
        if !request.expected_mod_time.is_empty() {
            let expected =
                DateTime::parse_from_rfc3339(&request.expected_mod_time).map_err(|_| {
                    CommandError::new(
                        "INVALID_MOD_TIME",
                        "expected_mod_time is not a valid RFC 3339 timestamp",
                    )
                })?;
            let current: DateTime<Utc> = info.modified.into();
            if current.timestamp_nanos_opt() != expected.timestamp_nanos_opt() {
                return Err(CommandError::new(
                    "FILE_MODIFIED",
                    "文件在编辑期间已被其他进程修改，请重新加载以避免覆盖",
                ));
            }
        }
    }
    let content = if request.line_ending == "crlf" {
        request.content.replace('\n', "\r\n")
    } else {
        request.content
    };
    if content.len() > MAX_EDITABLE_FILE_SIZE {
        return Err(CommandError::new(
            "FILE_TOO_LARGE",
            "保存后文件大小超过 10MB 上限",
        ));
    }
    backend
        .write(&path, content.as_bytes())
        .await
        .map_err(backend_error)?;
    let updated = backend.stat(&path).await.ok();
    let size = updated
        .as_ref()
        .map_or(content.len() as u64, |value| value.size);
    let mod_time = updated.map_or_else(
        || format_time(SystemTime::now()),
        |value| format_time(value.modified),
    );
    let action = if existing.is_some() {
        "sftp_write_file"
    } else {
        "sftp_create_file"
    };
    let _ = state.audit.record(
        &session.profile_id,
        action,
        format!("path={path} size={size}"),
    );
    Ok(SftpFileWriteResponse {
        path,
        size,
        mod_time,
    })
}

fn detect_line_ending(data: &[u8]) -> &'static str {
    let lf = data.iter().filter(|&&byte| byte == b'\n').count();
    if lf == 0 {
        return "lf";
    }
    let crlf = data.windows(2).filter(|pair| *pair == b"\r\n").count();
    if crlf * 100 / lf >= 30 {
        "crlf"
    } else {
        "lf"
    }
}

fn is_writable(mode: &str) -> bool {
    let mode = mode.trim().trim_start_matches(['d', '-']);
    mode.len() < 9 || mode.as_bytes().get(1) == Some(&b'w')
}

fn detect_language(path: &str) -> String {
    let name = Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let lower = name.to_lowercase();
    match lower.as_str() {
        "dockerfile" => return "dockerfile".into(),
        "makefile" | "gnumakefile" => return "makefile".into(),
        ".bashrc" | ".bash_profile" | ".bash_history" | ".profile" | ".zshrc" => {
            return "shell".into()
        }
        ".gitignore" | ".gitattributes" | ".dockerignore" => return "plaintext".into(),
        ".editorconfig" => return "ini".into(),
        _ => {}
    }
    if lower.starts_with("dockerfile.") {
        return "dockerfile".into();
    }
    if lower == "nginx.conf" || lower.ends_with(".conf") {
        return "nginx".into();
    }
    match lower
        .rsplit_once('.')
        .map(|(_, ext)| ext)
        .unwrap_or_default()
    {
        "sh" | "bash" | "zsh" | "ksh" => "shell",
        "yml" | "yaml" => "yaml",
        "json" => "json",
        "toml" => "toml",
        "xml" | "svg" => "xml",
        "py" | "pyw" => "python",
        "rb" => "ruby",
        "go" => "go",
        "rs" => "rust",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "ts" | "tsx" => "typescript",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" => "cpp",
        "cs" => "csharp",
        "php" => "php",
        "sql" => "sql",
        "md" | "markdown" => "markdown",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "html" | "htm" => "html",
        "ini" | "cfg" => "ini",
        "properties" => "properties",
        "env" => "plaintext",
        _ => "plaintext",
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_endings_require_thirty_percent_crlf() {
        assert_eq!(detect_line_ending(b"a\r\nb\r\nc\n"), "crlf");
        assert_eq!(detect_line_ending(b"a\r\nb\nc\nd\n"), "lf");
    }

    #[test]
    fn language_detection_matches_editor_contract() {
        assert_eq!(detect_language("/tmp/.bashrc"), "shell");
        assert_eq!(detect_language("/etc/nginx.conf"), "nginx");
        assert_eq!(detect_language("/src/main.tsx"), "typescript");
    }

    #[test]
    fn clean_and_join_paths_do_not_escape_root() {
        assert_eq!(clean_path("/tmp/../etc"), "/etc");
        assert_eq!(join_path("/tmp", "child"), "/tmp/child");
    }
}
