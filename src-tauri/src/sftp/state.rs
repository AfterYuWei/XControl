use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex as StdMutex},
    time::SystemTime,
};

use chrono::{DateTime, Local, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tokio::{
    sync::{Mutex, Notify, RwLock},
    task::JoinHandle,
};

#[cfg(test)]
use super::backend::join_path;
use super::backend::{base_name, clean_path, format_time, local_home_dir, FileBackend, FileInfo};
use super::transfer::TransferManager;
use super::{SftpError, SftpEventSink};
use crate::{
    audit::AuditRepository,
    error::CommandError,
    profile::ProfileService,
    ssh::transport::{connect_route, HostKeyVerifier},
};

const MAX_EDITABLE_FILE_SIZE: usize = 10 * 1024 * 1024;
const BINARY_SNIFF_SIZE: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SftpSessionInfo {
    id: String,
    profile_id: String,
    status: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    error: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    home_dir: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    host_key_fingerprint: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    known_host_key_fingerprint: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct SftpCreateSessionResponse {
    session_id: String,
    status: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    home_dir: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SftpEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    mod_time: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    mode: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct SftpTreeNode {
    #[serde(flatten)]
    entry: SftpEntry,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    children: Vec<SftpTreeNode>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SftpListResponse {
    path: String,
    entries: Vec<SftpEntry>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SftpTreeResponse {
    path: String,
    entries: Vec<SftpTreeNode>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SftpDeleteResponse {
    deleted: usize,
    failed: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct SftpFileReadResponse {
    path: String,
    content: String,
    size: u64,
    mod_time: String,
    language: String,
    line_ending: String,
    read_only: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SftpFileWriteRequest {
    content: String,
    #[serde(default)]
    expected_mod_time: String,
    #[serde(default)]
    line_ending: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct SftpFileWriteResponse {
    path: String,
    size: u64,
    mod_time: String,
}

struct SessionData {
    status: String,
    error: String,
    home_dir: String,
    backend: Option<Arc<FileBackend>>,
    host_key_fingerprint: String,
    known_host_key_fingerprint: String,
}

pub(super) struct SftpSession {
    pub(super) id: String,
    pub(super) profile_id: String,
    created_at: String,
    data: RwLock<SessionData>,
    host_key_decision: StdMutex<Option<SftpHostKeyDecision>>,
    host_key_notify: Notify,
    trusted_once_host_keys: StdMutex<HashSet<String>>,
}

#[derive(Clone)]
pub(crate) struct SftpService {
    pub(super) sessions: Arc<RwLock<HashMap<String, Arc<SftpSession>>>>,
    connection_tasks: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    pub(super) profiles: ProfileService,
    pub(super) audit: AuditRepository,
    pub(super) events: Arc<dyn SftpEventSink>,
    pub(super) transfers: TransferManager,
}

struct SftpHostKeyDecision {
    fingerprint: String,
    persist: bool,
}

struct SftpHostKeyVerifier {
    session: Arc<SftpSession>,
    events: Arc<dyn SftpEventSink>,
}

impl HostKeyVerifier for SftpHostKeyVerifier {
    fn verify<'a>(
        &'a self,
        _profile_id: &'a str,
        profile_name: &'a str,
        known: &'a str,
        current: &'a str,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            if known == current
                || self
                    .session
                    .trusted_once_host_keys
                    .lock()
                    .expect("trusted host key mutex poisoned")
                    .contains(current)
            {
                return true;
            }
            {
                let mut data = self.session.data.write().await;
                data.status = "hostkey_confirm".into();
                data.host_key_fingerprint = current.into();
                data.known_host_key_fingerprint = known.into();
            }
            self.events.emit_sftp(
                "sftp_session_status",
                serde_json::json!({
                    "session_id":self.session.id,
                    "status":"hostkey_confirm",
                    "profile_name":profile_name,
                    "host_key_fingerprint":current,
                    "known_host_key_fingerprint":known,
                }),
            );
            loop {
                self.session.host_key_notify.notified().await;
                let decision = self
                    .session
                    .host_key_decision
                    .lock()
                    .expect("host key decision mutex poisoned")
                    .take();
                if let Some(decision) = decision {
                    if decision.fingerprint != current {
                        return false;
                    }
                    if !decision.persist {
                        self.session
                            .trusted_once_host_keys
                            .lock()
                            .expect("trusted host key mutex poisoned")
                            .insert(current.to_owned());
                    }
                    return true;
                }
            }
        })
    }
}

impl SftpService {
    pub(crate) fn new(
        profiles: ProfileService,
        audit: AuditRepository,
        events: Arc<dyn SftpEventSink>,
    ) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            connection_tasks: Arc::new(Mutex::new(HashMap::new())),
            profiles,
            audit,
            events,
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
                host_key_fingerprint: String::new(),
                known_host_key_fingerprint: String::new(),
            }),
            host_key_decision: StdMutex::new(None),
            host_key_notify: Notify::new(),
            trusted_once_host_keys: StdMutex::new(HashSet::new()),
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
        let session_id = session.id.clone();
        let task = tokio::spawn(async move {
            state.connect_remote(session_for_task).await;
            state.connection_tasks.lock().await.remove(&session_id);
        });
        self.connection_tasks
            .lock()
            .await
            .insert(session.id.clone(), task);
        Ok(SftpCreateSessionResponse {
            session_id: session.id.clone(),
            status: "connecting".into(),
            home_dir: String::new(),
        })
    }

    async fn connect_remote(&self, session: Arc<SftpSession>) {
        let result =
            async {
                let resolved = self.profiles.resolve_connection(&session.profile_id)?;
                let route = connect_route(
                    resolved,
                    Arc::new(SftpHostKeyVerifier {
                        session: session.clone(),
                        events: self.events.clone(),
                    }),
                    None,
                )
                .await
                .map_err(|error| CommandError::new("SFTP_CONNECT_FAILED", error.to_string()))?;
                let stream = route
                    .open_subsystem("sftp")
                    .await
                    .map_err(|error| CommandError::new("SFTP_CONNECT_FAILED", error.to_string()))?;
                let sftp = Arc::new(russh_sftp::client::SftpSession::new(stream).await.map_err(
                    |error| CommandError::new("SFTP_CONNECT_FAILED", error.to_string()),
                )?);
                let home_dir = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());
                Ok::<_, CommandError>((route, sftp, clean_path(&home_dir)))
            }
            .await;

        match result {
            Ok((route, sftp, home_dir)) => {
                for (profile_id, fingerprint) in route.host_keys() {
                    let persist = !session
                        .trusted_once_host_keys
                        .lock()
                        .expect("trusted host key mutex poisoned")
                        .contains(fingerprint);
                    if persist {
                        if let Err(error) = self.profiles.persist_host_key(profile_id, fingerprint)
                        {
                            eprintln!("persist SFTP host key failed: {error}");
                        }
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
                    data.host_key_fingerprint.clear();
                    data.known_host_key_fingerprint.clear();
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
        self.events.emit_sftp(
            "sftp_session_status",
            serde_json::json!({"session_id":session_id,"status":status}),
        );
    }

    pub(crate) async fn active_count(&self) -> usize {
        let sessions = self
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut count = 0;
        for session in sessions {
            if session.profile_id == "local" {
                continue;
            }
            let status = session.data.read().await.status.clone();
            if matches!(status.as_str(), "connecting" | "connected" | "reconnecting") {
                count += 1;
            }
        }
        count
    }

    pub(crate) async fn suspend_for_background_limit(&self) {
        let tasks = self
            .connection_tasks
            .lock()
            .await
            .drain()
            .map(|(_, task)| task)
            .collect::<Vec<_>>();
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            let _ = task.await;
        }

        let sessions = self
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for session in sessions {
            if session.profile_id == "local" {
                continue;
            }
            self.transfers.cancel_session(&session.id).await;
            let mut data = session.data.write().await;
            if let Some(backend) = data.backend.take() {
                backend.close().await;
            }
            data.status = "suspended".into();
            data.error = "BACKGROUND_LIMIT: 后台恢复窗口已结束".into();
            drop(data);
            self.emit_session_status(&session.id, "suspended");
        }
    }

    pub(crate) async fn reconnect_suspended(&self) -> Result<(), CommandError> {
        let sessions = self
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for session in sessions {
            if session.profile_id != "local" && session.data.read().await.status == "suspended" {
                self.reconnect(&session.id).await?;
            }
        }
        Ok(())
    }

    pub(crate) async fn reconnect(
        &self,
        id: &str,
    ) -> Result<SftpCreateSessionResponse, CommandError> {
        let session = self.session(id).await?;
        if session.profile_id == "local" {
            return Err(CommandError::new(
                "VALIDATION",
                "local session does not require reconnect",
            ));
        }
        self.profiles.resolve_connection(&session.profile_id)?;
        if let Some(task) = self.connection_tasks.lock().await.remove(id) {
            task.abort();
            let _ = task.await;
        }
        {
            let mut data = session.data.write().await;
            if let Some(backend) = data.backend.take() {
                backend.close().await;
            }
            data.status = "reconnecting".into();
            data.error.clear();
        }
        self.emit_session_status(id, "reconnecting");
        let state = self.clone();
        let session_for_task = session.clone();
        let session_id = id.to_owned();
        let task = tokio::spawn(async move {
            state.connect_remote(session_for_task).await;
            state.connection_tasks.lock().await.remove(&session_id);
        });
        self.connection_tasks
            .lock()
            .await
            .insert(id.to_owned(), task);
        let home_dir = session.data.read().await.home_dir.clone();
        Ok(SftpCreateSessionResponse {
            session_id: id.to_owned(),
            status: "reconnecting".into(),
            home_dir,
        })
    }

    pub(crate) async fn decide_host_key(
        &self,
        id: &str,
        fingerprint: String,
        decision: &str,
    ) -> Result<serde_json::Value, CommandError> {
        let session = self.session(id).await?;
        let data = session.data.read().await;
        if data.status != "hostkey_confirm" || data.host_key_fingerprint != fingerprint {
            return Err(CommandError::new(
                "HOST_KEY_CONFIRM_FAILED",
                "SFTP host key request is no longer active",
            ));
        }
        drop(data);
        let persist = match decision {
            "trust_permanently" => true,
            "trust_once" => false,
            "reject" => {
                if let Some(task) = self.connection_tasks.lock().await.remove(id) {
                    task.abort();
                }
                let mut data = session.data.write().await;
                data.status = "disconnected".into();
                data.error = "主机指纹已拒绝".into();
                drop(data);
                self.emit_session_status(id, "disconnected");
                return Ok(serde_json::json!({"status":"rejected"}));
            }
            _ => {
                return Err(CommandError::new(
                    "VALIDATION",
                    "decision must be trust_once, trust_permanently or reject",
                ));
            }
        };
        *session
            .host_key_decision
            .lock()
            .expect("host key decision mutex poisoned") = Some(SftpHostKeyDecision {
            fingerprint,
            persist,
        });
        session.host_key_notify.notify_waiters();
        Ok(serde_json::json!({"status":"accepted","persisted":persist}))
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
            host_key_fingerprint: data.host_key_fingerprint.clone(),
            known_host_key_fingerprint: data.known_host_key_fingerprint.clone(),
            created_at: session.created_at.clone(),
        }
    }

    pub async fn shutdown(&self) {
        let connection_tasks = self
            .connection_tasks
            .lock()
            .await
            .drain()
            .map(|(_, task)| task)
            .collect::<Vec<_>>();
        for task in &connection_tasks {
            task.abort();
        }
        for task in connection_tasks {
            let _ = task.await;
        }
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
            .map_err(|error| CommandError::new("EXEC_FAILED", error.to_string()))
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
) -> Pin<Box<dyn Future<Output = Result<Vec<SftpTreeNode>, SftpError>> + Send + 'a>> {
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
) -> Pin<Box<dyn Future<Output = Result<(), SftpError>> + Send + 'a>> {
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

fn backend_error(error: SftpError) -> CommandError {
    let message = error.to_string();
    let lower = message.to_lowercase();
    let code = if lower.contains("not found") || lower.contains("no such") {
        "NOT_FOUND"
    } else if lower.contains("permission") || lower.contains("denied") {
        "PERMISSION_DENIED"
    } else if lower.contains("exist") {
        "PATH_EXISTS"
    } else {
        "INTERNAL"
    };
    CommandError::new(code, message)
}

pub(crate) async fn create_session(
    state: &SftpService,
    profile_id: String,
) -> Result<SftpCreateSessionResponse, CommandError> {
    state.create_session(profile_id).await
}

pub(crate) async fn get_session(
    state: &SftpService,
    id: String,
) -> Result<SftpSessionInfo, CommandError> {
    let session = state.session(&id).await?;
    Ok(SftpService::info(&session).await)
}

pub(crate) async fn list_sessions(
    state: &SftpService,
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
        result.push(SftpService::info(&session).await);
    }
    Ok(result)
}

pub(crate) async fn close_session(state: &SftpService, id: String) -> Result<(), CommandError> {
    let session = state
        .sessions
        .write()
        .await
        .remove(&id)
        .ok_or_else(|| CommandError::new("NOT_FOUND", "session not found"))?;
    let connection_task = state.connection_tasks.lock().await.remove(&id);
    if let Some(task) = connection_task {
        task.abort();
        let _ = task.await;
    }
    state.transfers.cancel_session(&id).await;
    if let Some(backend) = session.data.write().await.backend.take() {
        backend.close().await;
    }
    let _ = state
        .audit
        .record(&session.profile_id, "sftp_disconnect", "");
    Ok(())
}

pub(crate) async fn list(
    state: &SftpService,
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

pub(crate) async fn stat(
    state: &SftpService,
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

pub(crate) async fn tree_entries(
    state: &SftpService,
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

pub(crate) async fn mkdir(
    state: &SftpService,
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

pub(crate) async fn rename(
    state: &SftpService,
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

pub(crate) async fn delete(
    state: &SftpService,
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

pub(crate) async fn read_file(
    state: &SftpService,
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

pub(crate) async fn write_file(
    state: &SftpService,
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
