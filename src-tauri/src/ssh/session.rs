use std::{
    collections::{HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex as StdMutex},
};

use chrono::{Local, SecondsFormat};
use russh::{client, ChannelMsg, Disconnect, Pty};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::{
    sync::{mpsc, oneshot, Mutex, Notify},
    time::{timeout, Duration},
};
use tokio_util::sync::CancellationToken;

use super::transport::{
    connect_route, AuthenticationRequest, AuthenticationResponder, ClientHandler, ConnectedRoute,
    HostKeyVerifier,
};
use super::{session_manager::SessionManager, SessionEventSink, SshError};
use crate::{
    audit::AuditRepository,
    error::CommandError,
    profile::{ProfileService, ResolvedProfileNode},
};

const COMPLETE_TIMEOUT: Duration = Duration::from_millis(400);
const SHELL_DETECT_TIMEOUT: Duration = Duration::from_secs(10);
const PRE_ATTACH_OUTPUT_LIMIT: usize = 1024 * 1024;
const OUTPUT_BATCH_BYTES: usize = 32 * 1024;
const OUTPUT_BATCH_INTERVAL: Duration = Duration::from_millis(16);
const RECONNECT_BACKOFF_SECONDS: [u64; 10] = [1, 2, 4, 8, 16, 30, 30, 30, 30, 30];
const OSC7_BOOTSTRAP_ACK: &[u8] = b"\x1b]1337;eizhuOsc7Ready\x07";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RemoteShell {
    Bash,
    Zsh,
    Fish,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionLogEntry {
    at: i64,
    level: String,
    stage: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSnapshot {
    session_id: String,
    status: String,
    stage: String,
    message: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    error: String,
    #[serde(skip_serializing_if = "is_false")]
    waiting_for_host_key: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    host_key_fingerprint: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    known_host_key_fingerprint: String,
    #[serde(skip_serializing_if = "is_zero")]
    retry_attempt: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_retry_at: Option<i64>,
    logs: Vec<ConnectionLogEntry>,
    #[serde(skip)]
    version: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    id: String,
    profile_id: String,
    status: String,
    created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct SessionCreateRequest {
    profile_id: String,
    cols: Option<u32>,
    rows: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct SessionCreateResponse {
    session_id: String,
    status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClientMessage {
    session_id: String,
    #[serde(rename = "type")]
    message_type: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<Value>,
}

enum SessionCommand {
    Input(String),
    Resize(u32, u32),
    Ping {
        response: oneshot::Sender<Result<(), String>>,
    },
    Complete {
        request_id: String,
        script: String,
        cwd: Option<String>,
    },
}

pub(super) struct Session {
    id: String,
    profile_id: String,
    host: String,
    username: String,
    created_at: String,
    snapshot: StdMutex<SessionSnapshot>,
    host_key_decision: StdMutex<Option<HostKeyDecision>>,
    trusted_once_host_keys: StdMutex<HashSet<String>>,
    host_key_notify: Notify,
    pending_auth: StdMutex<Option<PendingAuthentication>>,
    auth_notify: Notify,
    cancel: CancellationToken,
    commands: Mutex<Option<mpsc::Sender<SessionCommand>>>,
    pending_resize: StdMutex<Option<(u32, u32)>>,
    dimensions: StdMutex<(u32, u32)>,
    delivery: StdMutex<SessionDelivery>,
    events: Arc<dyn SessionEventSink>,
}

#[derive(Default)]
struct SessionDelivery {
    attached: bool,
    output_bytes: usize,
    messages: Vec<ClientMessage>,
    subscriptions: HashMap<String, Channel<ClientMessage>>,
}

struct HostKeyDecision {
    fingerprint: String,
    persist: bool,
}

struct PendingAuthentication {
    request_id: String,
    responses: Option<Vec<String>>,
}

impl Session {
    fn new(
        profile: &ResolvedProfileNode,
        events: Arc<dyn SessionEventSink>,
        cols: u32,
        rows: u32,
    ) -> Self {
        Self::with_identity(
            profile,
            events,
            uuid::Uuid::new_v4().to_string(),
            cols,
            rows,
            false,
        )
    }

    fn reconnecting(
        profile: &ResolvedProfileNode,
        events: Arc<dyn SessionEventSink>,
        id: String,
        cols: u32,
        rows: u32,
        attached: bool,
    ) -> Self {
        Self::with_identity(profile, events, id, cols, rows, attached)
    }

    fn with_identity(
        profile: &ResolvedProfileNode,
        events: Arc<dyn SessionEventSink>,
        id: String,
        cols: u32,
        rows: u32,
        attached: bool,
    ) -> Self {
        let initial_log = ConnectionLogEntry {
            at: now_millis(),
            level: "info".into(),
            stage: "preparing".into(),
            message: "连接请求已创建，等待后端准备".into(),
        };
        Self {
            snapshot: StdMutex::new(SessionSnapshot {
                session_id: id.clone(),
                status: if attached {
                    "reconnecting".into()
                } else {
                    "connecting".into()
                },
                stage: "preparing".into(),
                message: initial_log.message.clone(),
                error: String::new(),
                waiting_for_host_key: false,
                host_key_fingerprint: String::new(),
                known_host_key_fingerprint: String::new(),
                retry_attempt: 0,
                next_retry_at: None,
                logs: vec![initial_log],
                version: 1,
            }),
            id,
            profile_id: profile.profile_id.clone(),
            host: profile.host.clone(),
            username: profile.username.clone(),
            created_at: Local::now().to_rfc3339_opts(SecondsFormat::AutoSi, true),
            host_key_decision: StdMutex::new(None),
            trusted_once_host_keys: StdMutex::new(HashSet::new()),
            host_key_notify: Notify::new(),
            pending_auth: StdMutex::new(None),
            auth_notify: Notify::new(),
            cancel: CancellationToken::new(),
            commands: Mutex::new(None),
            pending_resize: StdMutex::new(None),
            dimensions: StdMutex::new((cols, rows)),
            delivery: StdMutex::new(SessionDelivery {
                attached,
                ..SessionDelivery::default()
            }),
            events,
        }
    }

    fn snapshot(&self) -> SessionSnapshot {
        self.snapshot
            .lock()
            .expect("session mutex poisoned")
            .clone()
    }

    pub(super) fn id(&self) -> &str {
        &self.id
    }

    pub(super) fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            profile_id: self.profile_id.clone(),
            status: self.snapshot().status,
            created_at: self.created_at.clone(),
        }
    }

    pub(super) fn cancel(&self) {
        self.cancel.cancel();
        self.host_key_notify.notify_waiters();
        self.auth_notify.notify_waiters();
    }

    pub(super) fn dimensions(&self) -> (u32, u32) {
        *self.dimensions.lock().expect("dimensions mutex poisoned")
    }

    pub(super) fn is_attached(&self) -> bool {
        self.delivery
            .lock()
            .expect("delivery mutex poisoned")
            .attached
    }

    pub(super) fn status(&self) -> String {
        self.snapshot().status
    }

    pub(super) fn suspend_for_background_limit(&self) {
        self.cancel();
        self.snapshot.lock().expect("session mutex poisoned").status = "suspended".into();
        self.stage(
            "background_limit",
            "warn",
            "后台恢复窗口已结束，等待回到前台重连",
        );
        self.emit_message(
            "disconnect",
            "",
            Some(json!({
                "code":"BACKGROUND_LIMIT",
                "reason":"background_limit",
                "message":"后台恢复窗口已结束"
            })),
        );
    }

    fn stage(&self, stage: &str, level: &str, message: impl Into<String>) {
        let message = message.into();
        let snapshot = {
            let mut snapshot = self.snapshot.lock().expect("session mutex poisoned");
            snapshot.stage = stage.into();
            snapshot.message = message.clone();
            snapshot.logs.push(ConnectionLogEntry {
                at: now_millis(),
                level: level.into(),
                stage: stage.into(),
                message,
            });
            if snapshot.logs.len() > 200 {
                let drain = snapshot.logs.len() - 200;
                snapshot.logs.drain(..drain);
            }
            snapshot.version += 1;
            snapshot.clone()
        };
        self.emit_message("connection_state", "", Some(json!(snapshot)));
    }

    fn connected(&self, stage: &str, message: &str) {
        let mut snapshot = self.snapshot.lock().expect("session mutex poisoned");
        snapshot.status = "connected".into();
        snapshot.retry_attempt = 0;
        snapshot.next_retry_at = None;
        drop(snapshot);
        self.stage(stage, "info", message);
    }

    fn mark_reconnecting(&self, attempt: usize, delay_seconds: u64, reason: &str) {
        let next_retry_at = now_millis().saturating_add((delay_seconds as i64) * 1_000);
        let mut snapshot = self.snapshot.lock().expect("session mutex poisoned");
        snapshot.status = "reconnecting".into();
        snapshot.error = reason.into();
        snapshot.retry_attempt = attempt as u32;
        snapshot.next_retry_at = Some(next_retry_at);
        drop(snapshot);
        self.stage(
            "reconnecting",
            "warn",
            format!("连接中断，{delay_seconds} 秒后进行第 {attempt} 次恢复"),
        );
    }

    fn failed(&self, stage: &str, message: impl Into<String>) {
        let message = message.into();
        {
            let mut snapshot = self.snapshot.lock().expect("session mutex poisoned");
            snapshot.status = "disconnected".into();
            snapshot.error = message.clone();
        }
        self.stage(stage, "error", message.clone());
        self.emit_message(
            "error",
            "",
            Some(json!({"code":"SESSION_FAILED","message":message})),
        );
    }

    fn host_key_prompt(&self, current: &str, known: &str, profile_name: &str) {
        let changed = !known.is_empty();
        self.stage(
            "hostkey_confirm",
            "warn",
            if changed {
                format!("{profile_name} 的主机指纹发生变化")
            } else {
                format!("首次连接 {profile_name}，请确认主机指纹")
            },
        );
        {
            let mut snapshot = self.snapshot.lock().expect("session mutex poisoned");
            snapshot.waiting_for_host_key = true;
            snapshot.host_key_fingerprint = current.into();
            snapshot.known_host_key_fingerprint = known.into();
            snapshot.message = if changed {
                "检测到服务器主机指纹变化，等待确认".into()
            } else {
                "未知服务器主机指纹，等待确认".into()
            };
            snapshot.version += 1;
        }
        self.emit_message("connection_state", "", Some(json!(self.snapshot())));
    }

    fn should_persist_host_key(&self, fingerprint: &str) -> bool {
        !self
            .trusted_once_host_keys
            .lock()
            .expect("trusted host key mutex poisoned")
            .contains(fingerprint)
    }

    fn clear_host_key_prompt(&self, profile_name: &str) {
        {
            let mut snapshot = self.snapshot.lock().expect("session mutex poisoned");
            snapshot.waiting_for_host_key = false;
            snapshot.host_key_fingerprint.clear();
            snapshot.known_host_key_fingerprint.clear();
        }
        self.stage(
            "hostkey_check",
            "info",
            format!("已确认 {profile_name} 的新主机指纹"),
        );
    }

    fn provide_auth_response(&self, request_id: &str, responses: Vec<String>) -> bool {
        let mut pending = self
            .pending_auth
            .lock()
            .expect("authentication mutex poisoned");
        let Some(request) = pending.as_mut() else {
            return false;
        };
        if request.request_id != request_id || request.responses.is_some() {
            return false;
        }
        request.responses = Some(responses);
        drop(pending);
        self.auth_notify.notify_waiters();
        true
    }

    fn emit_message(&self, message_type: &str, data: &str, payload: Option<Value>) {
        let message = ClientMessage {
            session_id: self.id.clone(),
            message_type: message_type.into(),
            data: data.into(),
            payload,
        };
        let should_emit = {
            let mut delivery = self.delivery.lock().expect("delivery mutex poisoned");
            if message_type == "output" {
                delivery.output_bytes = delivery.output_bytes.saturating_add(data.len());
                if let Some(last) = delivery.messages.last_mut() {
                    if last.message_type == "output" {
                        last.data.push_str(data);
                    } else {
                        delivery.messages.push(message.clone());
                    }
                } else {
                    delivery.messages.push(message.clone());
                }
                while delivery.output_bytes > PRE_ATTACH_OUTPUT_LIMIT {
                    let Some(index) = delivery
                        .messages
                        .iter()
                        .position(|message| message.message_type == "output")
                    else {
                        delivery.output_bytes = 0;
                        break;
                    };
                    let excess = delivery.output_bytes - PRE_ATTACH_OUTPUT_LIMIT;
                    let length = delivery.messages[index].data.len();
                    if length <= excess {
                        delivery.output_bytes -= length;
                        delivery.messages.remove(index);
                    } else {
                        let boundary = delivery.messages[index]
                            .data
                            .char_indices()
                            .map(|(offset, _)| offset)
                            .find(|offset| *offset >= excess)
                            .unwrap_or(length);
                        delivery.messages[index].data.drain(..boundary);
                        delivery.output_bytes -= boundary;
                    }
                }
            }
            delivery
                .subscriptions
                .retain(|_, channel| channel.send(message.clone()).is_ok());
            delivery.attached
        };
        if should_emit {
            self.events.emit_session(json!(message));
        }
    }

    fn subscribe(&self, channel: Channel<ClientMessage>) -> String {
        let subscription_id = uuid::Uuid::new_v4().to_string();
        let mut delivery = self.delivery.lock().expect("delivery mutex poisoned");
        for message in self.initial_messages(delivery.attached) {
            let _ = channel.send(message);
        }
        for message in delivery.messages.iter().cloned() {
            let _ = channel.send(message);
        }
        delivery.attached = true;
        delivery
            .subscriptions
            .insert(subscription_id.clone(), channel);
        subscription_id
    }

    fn unsubscribe(&self, subscription_id: &str) {
        self.delivery
            .lock()
            .expect("delivery mutex poisoned")
            .subscriptions
            .remove(subscription_id);
    }

    fn metadata(&self) -> ClientMessage {
        ClientMessage {
            session_id: self.id.clone(),
            message_type: "metadata".into(),
            data: String::new(),
            payload: Some(json!({
                "session_id": self.id,
                "host": self.host,
                "username": self.username,
                "protocol": "ssh",
            })),
        }
    }

    fn initial_messages(&self, include_metadata: bool) -> Vec<ClientMessage> {
        let snapshot = self.snapshot();
        let connected = include_metadata && snapshot.status == "connected";
        let mut messages = vec![ClientMessage {
            session_id: self.id.clone(),
            message_type: "connection_state".into(),
            data: String::new(),
            payload: Some(json!(snapshot)),
        }];
        if connected {
            messages.push(self.metadata());
        }
        messages
    }

    fn attach_messages(&self) -> Vec<ClientMessage> {
        let mut delivery = self.delivery.lock().expect("delivery mutex poisoned");
        // The first attach replays the buffered metadata in exact event order.
        // Later attaches need a synthetic metadata message to initialize a
        // remounted terminal while the session is still connected.
        let mut messages = self.initial_messages(delivery.attached);
        messages.append(&mut delivery.messages);
        delivery.output_bytes = 0;
        delivery.attached = true;
        messages
    }
}

struct SessionHostKeyVerifier {
    session: Arc<Session>,
}

impl HostKeyVerifier for SessionHostKeyVerifier {
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
            self.session.host_key_prompt(current, known, profile_name);
            loop {
                tokio::select! {
                    _ = self.session.cancel.cancelled() => return false,
                    _ = self.session.host_key_notify.notified() => {
                        let decision = self.session.host_key_decision
                            .lock().expect("host key decision mutex poisoned").take();
                        if let Some(decision) = decision {
                            if decision.fingerprint == current {
                                if !decision.persist {
                                    self.session.trusted_once_host_keys
                                        .lock().expect("trusted host key mutex poisoned")
                                        .insert(current.to_owned());
                                }
                                self.session.clear_host_key_prompt(profile_name);
                                return true;
                            }
                            return false;
                        }
                    }
                }
            }
        })
    }
}

impl AuthenticationResponder for Session {
    fn respond<'a>(
        &'a self,
        request: AuthenticationRequest,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, String>> + Send + 'a>> {
        Box::pin(async move {
            let request_id = uuid::Uuid::new_v4().to_string();
            let prompts = request
                .prompts
                .iter()
                .map(|prompt| json!({"prompt":prompt.prompt,"echo":prompt.echo}))
                .collect::<Vec<_>>();
            *self
                .pending_auth
                .lock()
                .expect("authentication mutex poisoned") = Some(PendingAuthentication {
                request_id: request_id.clone(),
                responses: None,
            });
            self.stage("auth_interactive", "warn", "服务器需要补充交互式认证信息");
            self.emit_message(
                "auth_request",
                "",
                Some(json!({
                    "request_id":request_id,
                    "profile_id":request.profile_id,
                    "name":request.name,
                    "instructions":request.instructions,
                    "prompts":prompts,
                })),
            );
            loop {
                let response = {
                    let mut pending = self
                        .pending_auth
                        .lock()
                        .expect("authentication mutex poisoned");
                    pending
                        .as_mut()
                        .and_then(|request| request.responses.take())
                };
                if let Some(response) = response {
                    *self
                        .pending_auth
                        .lock()
                        .expect("authentication mutex poisoned") = None;
                    return Ok(response);
                }
                tokio::select! {
                    _ = self.cancel.cancelled() => {
                        return Err("用户取消了 keyboard-interactive 认证".into());
                    }
                    _ = self.auth_notify.notified() => {}
                }
            }
        })
    }
}

#[derive(Clone)]
pub(crate) struct SshService {
    manager: SessionManager,
    profiles: ProfileService,
    audit: AuditRepository,
    events: Arc<dyn SessionEventSink>,
}

impl SshService {
    pub(crate) fn new(
        profiles: ProfileService,
        audit: AuditRepository,
        events: Arc<dyn SessionEventSink>,
    ) -> Self {
        Self {
            manager: SessionManager::default(),
            profiles,
            audit,
            events,
        }
    }

    pub(crate) async fn create(
        &self,
        request: SessionCreateRequest,
    ) -> Result<SessionCreateResponse, CommandError> {
        if request.profile_id.is_empty() {
            return Err(CommandError::new("VALIDATION", "profile_id is required"));
        }
        let resolved = self.profiles.resolve_connection(&request.profile_id)?;
        let cols = request.cols.filter(|value| *value > 0).unwrap_or(80);
        let rows = request.rows.filter(|value| *value > 0).unwrap_or(24);
        let session = Arc::new(Session::new(&resolved, self.events.clone(), cols, rows));
        let response = SessionCreateResponse {
            session_id: session.id.clone(),
            status: "connecting".into(),
        };
        self.manager.register(session.clone()).await;
        session.stage("preparing", "info", "已读取连接配置，准备建立 SSH 会话");
        let state = self.clone();
        let task = tokio::spawn(async move {
            state.run_session(session, resolved, cols, rows).await;
        });
        self.manager.track(response.session_id.clone(), task).await;
        Ok(response)
    }

    async fn run_session(
        &self,
        session: Arc<Session>,
        resolved: ResolvedProfileNode,
        cols: u32,
        rows: u32,
    ) {
        let profile_id = resolved.profile_id.clone();
        let mut initial_resolved = Some(resolved);
        for attempt in 0..=RECONNECT_BACKOFF_SECONDS.len() {
            let resolved = if let Some(resolved) = initial_resolved.take() {
                resolved
            } else {
                match self.profiles.resolve_connection(&profile_id) {
                    Ok(resolved) => resolved,
                    Err(error) => {
                        session.failed("credential", error.to_string());
                        return;
                    }
                }
            };
            session.stage("credential", "info", "正在准备连接凭据");
            session.stage("hostkey_check", "info", "正在检查服务器主机指纹");
            session.stage(
                "establishing_ssh",
                "info",
                "正在建立 TCP 连接并协商 SSH 安全通道",
            );
            let verifier = Arc::new(SessionHostKeyVerifier {
                session: session.clone(),
            });
            let route = tokio::select! {
                _ = session.cancel.cancelled() => return,
                result = connect_route(resolved, verifier, Some(session.clone())) => result,
            };
            let route = match route {
                Ok(route) => route,
                Err(error) => {
                    let reason = format!("SSH 握手或认证失败: {error}");
                    if !self.wait_for_retry(&session, attempt, &reason).await {
                        return;
                    }
                    continue;
                }
            };
            session.stage("establishing_ssh", "info", "SSH 握手完成，认证通过");
            session.stage("starting_shell", "info", "正在启动远程 Shell");
            if let Err(error) = self.run_terminal(session.clone(), route, cols, rows).await {
                if !self
                    .wait_for_retry(&session, attempt, &error.to_string())
                    .await
                {
                    return;
                }
                continue;
            }
            if session.status() == "error" {
                if !self
                    .wait_for_retry(&session, attempt, "网络连接已中断")
                    .await
                {
                    return;
                }
                continue;
            }
            return;
        }
    }

    async fn wait_for_retry(&self, session: &Arc<Session>, attempt: usize, reason: &str) -> bool {
        if session.cancel.is_cancelled() {
            return false;
        }
        let Some(delay) = RECONNECT_BACKOFF_SECONDS.get(attempt).copied() else {
            session.failed("reconnect_failed", format!("自动恢复失败: {reason}"));
            return false;
        };
        session.mark_reconnecting(attempt + 1, delay, reason);
        tokio::select! {
            _ = session.cancel.cancelled() => false,
            _ = tokio::time::sleep(Duration::from_secs(delay)) => true,
        }
    }

    async fn run_terminal(
        &self,
        session: Arc<Session>,
        route: ConnectedRoute,
        cols: u32,
        rows: u32,
    ) -> Result<(), SshError> {
        let mut channel = route
            .handle
            .channel_open_session()
            .await
            .map_err(|error| format!("创建 SSH 会话通道: {error}"))?;
        channel
            .request_pty(
                true,
                "xterm-256color",
                cols,
                rows,
                0,
                0,
                &[(Pty::ECHO, 1), (Pty::IUTF8, 1)],
            )
            .await
            .map_err(|error| format!("请求远程 PTY: {error}"))?;
        let _ = channel.set_env(false, "LANG", "en_US.UTF-8").await;
        channel
            .request_shell(true)
            .await
            .map_err(|error| format!("启动远程 Shell: {error}"))?;

        // The interactive channel must be the first session opened after
        // authentication. Some OpenSSH/PAM configurations deliver the login
        // MOTD only to that first channel. Detecting the shell beforehand via
        // exec consumed banners such as "Welcome to Ubuntu" and then discarded
        // them. Once request_shell succeeds, its output is buffered by russh
        // while the auxiliary detection channel runs.
        session.stage("starting_shell", "info", "正在识别远程 Shell");
        let osc7_setup = detect_remote_shell(&route.handle)
            .await
            .map(osc7_setup_command);

        let (commands_tx, mut commands_rx) = mpsc::channel(128);
        *session.commands.lock().await = Some(commands_tx);
        let pending_resize = session
            .pending_resize
            .lock()
            .expect("resize mutex poisoned")
            .take();
        if let Some((pending_cols, pending_rows)) = pending_resize {
            let _ = channel
                .window_change(pending_cols, pending_rows, 0, 0)
                .await;
        }

        session.stage(
            "starting_shell",
            "info",
            "远程 Shell 已启动，正在初始化终端",
        );
        for (profile_id, fingerprint) in &route.host_keys {
            if session.should_persist_host_key(fingerprint) {
                let _ = self.profiles.persist_host_key(profile_id, fingerprint);
            }
        }
        let _ = self.profiles.update_last_used(&session.profile_id);
        let _ = self.audit.record(&session.profile_id, "connect", "");
        // Hold incomplete startup lines until the setup acknowledgement arrives.
        // This makes the injected command invisible even when a slow-starting
        // shell echoes or redraws the queued input after rendering its prompt.
        // Unknown shells are left untouched rather than receiving incompatible
        // syntax in their interactive input stream.
        let (mut filter, mut terminal_ready) = if let Some(command) = osc7_setup {
            channel
                .data_bytes(format!("{command}\n").into_bytes())
                .await
                .map_err(|error| format!("初始化终端目录跟踪: {error}"))?;
            (TerminalOutputFilter::with_osc7_bootstrap(&command), false)
        } else {
            session.connected("ready", "终端已就绪，远程 Shell 不支持自动目录跟踪");
            let metadata = session.metadata();
            session.emit_message(&metadata.message_type, &metadata.data, metadata.payload);
            (TerminalOutputFilter::default(), true)
        };
        let mut exit_code = 0_u32;
        let mut normal_exit = false;
        let mut pending_output = String::new();
        let mut output_flush = tokio::time::interval(OUTPUT_BATCH_INTERVAL);
        output_flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        output_flush.tick().await;
        loop {
            tokio::select! {
                _ = session.cancel.cancelled() => {
                    let _ = channel.close().await;
                    let _ = route.handle.disconnect(
                        Disconnect::ByApplication,
                        "session closed",
                        "zh-CN",
                    ).await;
                    break;
                }
                command = commands_rx.recv() => match command {
                    Some(SessionCommand::Input(data)) => {
                        channel.data_bytes(data.into_bytes()).await
                            .map_err(|error| format!("写入远程 Shell: {error}"))?;
                    }
                    Some(SessionCommand::Resize(cols, rows)) => {
                        channel.window_change(cols, rows, 0, 0).await
                            .map_err(|error| format!("调整远程 PTY: {error}"))?;
                    }
                    Some(SessionCommand::Ping { response }) => {
                        let result = match timeout(Duration::from_secs(5), route.handle.send_ping()).await {
                            Ok(Ok(())) => Ok(()),
                            Ok(Err(error)) => Err(error.to_string()),
                            Err(_) => Err("SSH probe timed out after 5 seconds".into()),
                        };
                        if result.is_ok() {
                            session.emit_message("pong", "", None);
                        }
                        let _ = response.send(result);
                    }
                    Some(SessionCommand::Complete { request_id, script, cwd }) => {
                        let result = run_completion(&route.handle, script, cwd).await;
                        let payload = match result {
                            Ok((output, code)) => json!({
                                "request_id":request_id,
                                "output":output,
                                "error":"",
                                "exit_code":code,
                            }),
                            Err(error) => json!({
                                "request_id":request_id,
                                "output":"",
                                "error":error.to_string(),
                                "exit_code":-1,
                            }),
                        };
                        session.emit_message("complete_response", "", Some(payload));
                    }
                    None => session.cancel.cancel(),
                },
                _ = output_flush.tick(), if !pending_output.is_empty() => {
                    session.emit_message("output", &std::mem::take(&mut pending_output), None);
                }
                message = channel.wait() => match message {
                    Some(ChannelMsg::Data { data })
                    | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let output = filter.push(&data);
                        if output.osc7_ready && !terminal_ready {
                            terminal_ready = true;
                            session.connected("ready", "终端已就绪，开始接收远程输出");
                            let metadata = session.metadata();
                            session.emit_message(
                                &metadata.message_type,
                                &metadata.data,
                                metadata.payload,
                            );
                        }
                        if let Some(cwd) = output.cwd {
                            session.emit_message("cwd", "", Some(json!({"path":cwd})));
                        }
                        if !output.data.is_empty() {
                            pending_output.push_str(&output.data);
                            if pending_output.len() >= OUTPUT_BATCH_BYTES {
                                session.emit_message(
                                    "output",
                                    &std::mem::take(&mut pending_output),
                                    None,
                                );
                            }
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = exit_status;
                        normal_exit = true;
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        }

        if !pending_output.is_empty() {
            session.emit_message("output", &pending_output, None);
        }

        *session.commands.lock().await = None;
        let _ = self.audit.record(&session.profile_id, "disconnect", "");
        if !session.cancel.is_cancelled() && !normal_exit {
            let message = "网络连接已中断";
            session
                .snapshot
                .lock()
                .expect("session mutex poisoned")
                .status = "error".into();
            session.stage("disconnected", "error", message);
            session.emit_message(
                "disconnect",
                "",
                Some(json!({"reason":"network_error","message":message})),
            );
        } else if !session.cancel.is_cancelled() {
            session
                .snapshot
                .lock()
                .expect("session mutex poisoned")
                .status = "disconnected".into();
            session.stage("disconnected", "info", "远程 Shell 已结束");
            session.emit_message("exit", "", Some(json!({"code":exit_code})));
        }
        Ok(())
    }

    pub(crate) async fn list(&self) -> Result<Vec<SessionInfo>, CommandError> {
        Ok(self.manager.list().await)
    }

    pub(crate) async fn attach(&self, id: &str) -> Result<Vec<ClientMessage>, CommandError> {
        Ok(self.manager.get(id).await?.attach_messages())
    }

    pub(crate) async fn subscribe(
        &self,
        id: &str,
        channel: Channel<ClientMessage>,
    ) -> Result<String, CommandError> {
        Ok(self.manager.get(id).await?.subscribe(channel))
    }

    pub(crate) async fn unsubscribe(
        &self,
        id: &str,
        subscription_id: &str,
    ) -> Result<(), CommandError> {
        self.manager.get(id).await?.unsubscribe(subscription_id);
        Ok(())
    }

    pub(crate) async fn confirm_host_key(
        &self,
        id: &str,
        fingerprint: Option<String>,
    ) -> Result<Value, CommandError> {
        let session = self.manager.get(id).await?;
        let snapshot = session.snapshot();
        if !snapshot.waiting_for_host_key {
            return Err(CommandError::new(
                "HOST_KEY_CONFIRM_FAILED",
                "session is not waiting for host key confirmation",
            ));
        }
        let fingerprint = fingerprint.unwrap_or(snapshot.host_key_fingerprint.clone());
        if fingerprint != snapshot.host_key_fingerprint {
            return Err(CommandError::new(
                "HOST_KEY_CONFIRM_FAILED",
                "host key fingerprint mismatch",
            ));
        }
        *session
            .host_key_decision
            .lock()
            .expect("host key decision mutex poisoned") = Some(HostKeyDecision {
            fingerprint,
            persist: true,
        });
        session.host_key_notify.notify_waiters();
        Ok(json!({"status":"accepted"}))
    }

    pub(crate) async fn decide_host_key(
        &self,
        id: &str,
        fingerprint: String,
        decision: &str,
    ) -> Result<Value, CommandError> {
        let session = self.manager.get(id).await?;
        let snapshot = session.snapshot();
        if !snapshot.waiting_for_host_key || fingerprint != snapshot.host_key_fingerprint {
            return Err(CommandError::new(
                "HOST_KEY_CONFIRM_FAILED",
                "session host key request is no longer active",
            ));
        }
        let persist = match decision {
            "trust_permanently" => true,
            "trust_once" => false,
            "reject" => {
                session.cancel();
                return Ok(json!({"status":"rejected"}));
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
            .expect("host key decision mutex poisoned") = Some(HostKeyDecision {
            fingerprint,
            persist,
        });
        session.host_key_notify.notify_waiters();
        Ok(json!({"status":"accepted","persisted":persist}))
    }

    pub(crate) async fn input(&self, id: &str, data: String) -> Result<(), CommandError> {
        self.send_command(id, SessionCommand::Input(data)).await
    }

    pub(crate) async fn resize(&self, id: &str, cols: u32, rows: u32) -> Result<(), CommandError> {
        if cols == 0 || rows == 0 {
            return Ok(());
        }
        let session = self.manager.get(id).await?;
        *session
            .dimensions
            .lock()
            .expect("dimensions mutex poisoned") = (cols, rows);
        let sender = session.commands.lock().await.clone();
        if let Some(sender) = sender {
            sender
                .send(SessionCommand::Resize(cols, rows))
                .await
                .map_err(|_| CommandError::new("SESSION_CLOSED", "session is closed"))?;
        } else {
            *session
                .pending_resize
                .lock()
                .expect("resize mutex poisoned") = Some((cols, rows));
        }
        Ok(())
    }

    pub(crate) async fn ping(&self, id: &str) -> Result<(), CommandError> {
        let (response, receiver) = oneshot::channel();
        self.send_command(id, SessionCommand::Ping { response })
            .await?;
        receiver
            .await
            .map_err(|_| CommandError::new("SESSION_CLOSED", "SSH probe was interrupted"))?
            .map_err(|error| CommandError::new("SSH_PROBE_FAILED", error))
    }

    pub(crate) async fn complete(
        &self,
        id: &str,
        request_id: String,
        script: String,
        cwd: Option<String>,
    ) -> Result<(), CommandError> {
        if request_id.is_empty() || script.is_empty() {
            return Ok(());
        }
        self.send_command(
            id,
            SessionCommand::Complete {
                request_id,
                script,
                cwd,
            },
        )
        .await
    }

    pub(crate) async fn respond_auth(
        &self,
        request_id: &str,
        responses: Vec<String>,
    ) -> Result<(), CommandError> {
        if responses.len() > 32 {
            return Err(CommandError::new(
                "VALIDATION",
                "too many authentication responses",
            ));
        }
        for session in self.manager.sessions().await {
            if session.provide_auth_response(request_id, responses.clone()) {
                return Ok(());
            }
        }
        Err(CommandError::new(
            "AUTH_REQUEST_NOT_FOUND",
            "authentication request is no longer active",
        ))
    }

    pub(crate) async fn close(&self, id: &str) -> Result<(), CommandError> {
        self.manager.close(id).await
    }

    pub(crate) async fn active_count(&self) -> usize {
        self.manager
            .sessions()
            .await
            .into_iter()
            .filter(|session| {
                matches!(
                    session.status().as_str(),
                    "connecting" | "connected" | "reconnecting"
                )
            })
            .count()
    }

    pub(crate) async fn probe_active(&self) {
        let ids = self
            .manager
            .sessions()
            .await
            .into_iter()
            .filter(|session| session.status() == "connected")
            .map(|session| session.id().to_owned())
            .collect::<Vec<_>>();
        for id in ids {
            if self.ping(&id).await.is_err() {
                let _ = self.reconnect(&id).await;
            }
        }
    }

    pub(crate) async fn suspend_for_background_limit(&self) {
        self.manager.suspend_all().await;
    }

    pub(crate) async fn reconnect_suspended(&self) -> Result<(), CommandError> {
        let ids = self
            .manager
            .sessions()
            .await
            .into_iter()
            .filter(|session| session.status() == "suspended")
            .map(|session| session.id().to_owned())
            .collect::<Vec<_>>();
        for id in ids {
            self.reconnect(&id).await?;
        }
        Ok(())
    }

    pub(crate) async fn reconnect(&self, id: &str) -> Result<SessionCreateResponse, CommandError> {
        let previous = self.manager.get(id).await?;
        let resolved = self.profiles.resolve_connection(&previous.profile_id)?;
        let (cols, rows) = previous.dimensions();
        let session = Arc::new(Session::reconnecting(
            &resolved,
            self.events.clone(),
            id.to_owned(),
            cols,
            rows,
            previous.is_attached(),
        ));
        session.stage("reconnecting", "info", "正在恢复 SSH 会话");
        self.manager.replace(id, session.clone()).await;
        let state = self.clone();
        let task = tokio::spawn(async move {
            state.run_session(session, resolved, cols, rows).await;
        });
        self.manager.track(id.to_owned(), task).await;
        Ok(SessionCreateResponse {
            session_id: id.to_owned(),
            status: "reconnecting".into(),
        })
    }

    async fn send_command(&self, id: &str, command: SessionCommand) -> Result<(), CommandError> {
        let session = self.manager.get(id).await?;
        let sender =
            session.commands.lock().await.clone().ok_or_else(|| {
                CommandError::new("SESSION_NOT_READY", "remote shell is not ready")
            })?;
        sender
            .send(command)
            .await
            .map_err(|_| CommandError::new("SESSION_CLOSED", "session is closed"))
    }

    pub(crate) async fn shutdown(&self) {
        self.manager.shutdown().await;
    }
}

async fn detect_remote_shell(handle: &client::Handle<ClientHandler>) -> Option<RemoteShell> {
    let output = timeout(SHELL_DETECT_TIMEOUT, async {
        let mut channel = handle.channel_open_session().await.ok()?;
        channel.exec(true, r#"printf '%s\n' "$SHELL""#).await.ok()?;
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await {
            if let ChannelMsg::Data { data } = message {
                output.extend_from_slice(&data);
            }
        }
        Some(String::from_utf8_lossy(&output).into_owned())
    })
    .await
    .ok()??;

    classify_remote_shell(&output)
}

fn classify_remote_shell(output: &str) -> Option<RemoteShell> {
    output.lines().rev().find_map(|line| {
        let name = line
            .trim()
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .trim_start_matches('-');
        match name {
            "bash" => Some(RemoteShell::Bash),
            "zsh" => Some(RemoteShell::Zsh),
            "fish" => Some(RemoteShell::Fish),
            _ => None,
        }
    })
}

fn osc7_setup_command(shell: RemoteShell) -> String {
    let hook = match shell {
        RemoteShell::Bash => {
            r#" __eizhu_osc7(){ printf "\033]7;file://%s\007" "$(pwd -P 2>/dev/null)";};case "${PROMPT_COMMAND-}" in *__eizhu_osc7*) ;; *) PROMPT_COMMAND="__eizhu_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}";;esac;__eizhu_osc7"#
        }
        RemoteShell::Zsh => {
            r#" __eizhu_osc7(){ printf "\033]7;file://%s\007" "$(pwd -P 2>/dev/null)";};autoload -Uz add-zsh-hook;add-zsh-hook -d precmd __eizhu_osc7 2>/dev/null;add-zsh-hook precmd __eizhu_osc7;__eizhu_osc7"#
        }
        RemoteShell::Fish => {
            r#" function __eizhu_osc7 --on-variable PWD --on-event fish_prompt;printf '\033]7;file://%s\007' (pwd -P 2>/dev/null);end;__eizhu_osc7"#
        }
    };
    format!(r#"{hook};printf "\033]1337;eizhuOsc7Ready\007""#)
}

async fn run_completion(
    handle: &client::Handle<ClientHandler>,
    script: String,
    cwd: Option<String>,
) -> Result<(String, i32), SshError> {
    let command = match cwd.filter(|value| !value.is_empty()) {
        Some(cwd) => format!("cd {} && {script}", shell_quote(&cwd)),
        None => script,
    };
    timeout(COMPLETE_TIMEOUT, async {
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|error| error.to_string())?;
        channel
            .exec(true, command)
            .await
            .map_err(|error| error.to_string())?;
        let mut output = Vec::new();
        let mut code = 0_i32;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => output.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => code = exit_status as i32,
                _ => {}
            }
        }
        Ok::<_, SshError>((String::from_utf8_lossy(&output).into_owned(), code))
    })
    .await
    .map_err(|_| "timeout".to_owned())?
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[derive(Default)]
struct TerminalOutputFilter {
    utf8_carry: Vec<u8>,
    osc7_buffer: Vec<u8>,
    osc7_bootstrap: Option<Osc7BootstrapFilter>,
}

struct FilteredOutput {
    data: String,
    cwd: Option<String>,
    osc7_ready: bool,
}

impl TerminalOutputFilter {
    fn with_osc7_bootstrap(setup_command: &str) -> Self {
        Self {
            osc7_bootstrap: Some(Osc7BootstrapFilter::new(setup_command)),
            ..Self::default()
        }
    }

    fn push(&mut self, input: &[u8]) -> FilteredOutput {
        let mut bytes = std::mem::take(&mut self.utf8_carry);
        bytes.extend_from_slice(input);
        let valid_len = match std::str::from_utf8(&bytes) {
            Ok(_) => bytes.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(_) => bytes.len(),
        };
        self.utf8_carry.extend_from_slice(&bytes[valid_len..]);
        bytes.truncate(valid_len);
        self.osc7_buffer.extend_from_slice(&bytes);
        if self.osc7_buffer.len() > 1024 * 1024 {
            let start = self.osc7_buffer.len() - 512 * 1024;
            self.osc7_buffer.drain(..start);
        }
        let cwd = extract_osc7(&mut self.osc7_buffer);
        let mut osc7_ready = false;
        let bytes = match self.osc7_bootstrap.as_mut() {
            Some(bootstrap) => {
                let (data, complete) = bootstrap.push(&bytes);
                if complete {
                    self.osc7_bootstrap = None;
                    osc7_ready = true;
                }
                data
            }
            None => bytes,
        };
        let mut data = String::from_utf8_lossy(&bytes).into_owned();
        for stale in [
            "-bash: 2004h: command not found\n",
            "-bash: 2004h: command not found\r\n",
            "-bash: 2004l: command not found\n",
            "-bash: 2004l: command not found\r\n",
        ] {
            data = data.replace(stale, "");
        }
        FilteredOutput {
            data,
            cwd,
            osc7_ready,
        }
    }
}

struct Osc7BootstrapFilter {
    pending_line: Vec<u8>,
    setup_command: Vec<u8>,
}

impl Osc7BootstrapFilter {
    fn new(setup_command: &str) -> Self {
        Self {
            pending_line: Vec::new(),
            setup_command: setup_command.trim_start().as_bytes().to_vec(),
        }
    }

    /// Buffers only the current incomplete terminal line. Complete banner lines
    /// are released immediately, while any line containing the injected setup
    /// command is discarded. The binary acknowledgement cannot be confused with
    /// the command's printable `\\033` text and removes all timing assumptions.
    fn push(&mut self, input: &[u8]) -> (Vec<u8>, bool) {
        self.pending_line.extend_from_slice(input);

        if let Some(ack_start) = find_bytes(&self.pending_line, OSC7_BOOTSTRAP_ACK) {
            let ack_end = ack_start + OSC7_BOOTSTRAP_ACK.len();
            let mut complete = std::mem::take(&mut self.pending_line);
            complete.drain(ack_start..ack_end);
            return (
                strip_osc7_setup_echoes(&complete, &self.setup_command),
                true,
            );
        }

        let Some(line_end) = self.pending_line.iter().rposition(|byte| *byte == b'\n') else {
            return (Vec::new(), false);
        };
        let tail = self.pending_line.split_off(line_end + 1);
        let complete_lines = std::mem::replace(&mut self.pending_line, tail);
        (
            strip_osc7_setup_echoes(&complete_lines, &self.setup_command),
            false,
        )
    }
}

fn strip_osc7_setup_echoes(input: &[u8], target: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(input.len());
    let mut start = 0;

    for (index, byte) in input.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        let line = &input[start..=index];
        if find_bytes(line, target).is_none() {
            output.extend_from_slice(line);
        }
        start = index + 1;
    }

    if start < input.len() {
        let line = &input[start..];
        if find_bytes(line, target).is_none() {
            output.extend_from_slice(line);
        }
    }

    output
}

fn extract_osc7(buffer: &mut Vec<u8>) -> Option<String> {
    const PREFIX: &[u8] = b"\x1b]7;";
    let mut result = None;
    loop {
        let Some(start) = find_bytes(buffer, PREFIX) else {
            if buffer.len() > PREFIX.len() - 1 {
                let keep = PREFIX.len() - 1;
                buffer.drain(..buffer.len() - keep);
            }
            break;
        };
        let payload_start = start + PREFIX.len();
        let terminator = buffer[payload_start..]
            .iter()
            .position(|byte| *byte == 7)
            .map(|offset| (payload_start + offset, 1))
            .or_else(|| {
                find_bytes(&buffer[payload_start..], b"\x1b\\")
                    .map(|offset| (payload_start + offset, 2))
            });
        let Some((end, terminator_len)) = terminator else {
            buffer.drain(..start);
            break;
        };
        if end - payload_start <= 4096 {
            let uri = String::from_utf8_lossy(&buffer[payload_start..end]);
            if let Some(path) = uri
                .strip_prefix("file://")
                .and_then(|rest| rest.find('/').map(|index| &rest[index..]))
            {
                if let Ok(decoded) = percent_encoding::percent_decode_str(path).decode_utf8() {
                    if decoded.starts_with('/') {
                        result = Some(normalize_remote_path(&decoded));
                    }
                }
            }
        }
        buffer.drain(..end + terminator_len);
    }
    result
}

fn normalize_remote_path(path: &str) -> String {
    let mut components = Vec::new();
    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            value => components.push(value),
        }
    }
    format!("/{}", components.join("/"))
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

fn now_millis() -> i64 {
    Local::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn reconnect_backoff_is_bounded_to_ten_attempts() {
        assert_eq!(RECONNECT_BACKOFF_SECONDS.len(), 10);
        assert_eq!(&RECONNECT_BACKOFF_SECONDS[..6], &[1, 2, 4, 8, 16, 30]);
        assert!(RECONNECT_BACKOFF_SECONDS[5..]
            .iter()
            .all(|delay| *delay == 30));
    }

    #[test]
    fn extracts_and_normalizes_osc7_paths() {
        let mut data = b"before\x1b]7;file://host/a/../b%20c\x07after".to_vec();
        assert_eq!(extract_osc7(&mut data).as_deref(), Some("/b c"));
    }

    #[test]
    fn carries_incomplete_utf8_between_packets() {
        let mut filter = TerminalOutputFilter::default();
        let bytes = "中文".as_bytes();
        let first = filter.push(&bytes[..4]);
        let second = filter.push(&bytes[4..]);
        assert_eq!(first.data, "中");
        assert_eq!(second.data, "文");
    }

    #[test]
    fn osc_setup_uses_shell_quotes_not_literal_backslashes() {
        for shell in [RemoteShell::Bash, RemoteShell::Zsh, RemoteShell::Fish] {
            let command = osc7_setup_command(shell);
            assert!(command.contains("printf \"\\033]7;") || command.contains("printf '\\033]7;"));
            assert!(!command.contains("printf \\\\\\\""));
            assert!(command.contains("eizhuOsc7Ready"));
        }
    }

    #[test]
    fn classifies_supported_remote_shell_paths() {
        assert_eq!(
            classify_remote_shell("/bin/bash\n"),
            Some(RemoteShell::Bash)
        );
        assert_eq!(
            classify_remote_shell("/usr/bin/zsh\r\n"),
            Some(RemoteShell::Zsh)
        );
        assert_eq!(
            classify_remote_shell("/opt/fish/bin/fish\n"),
            Some(RemoteShell::Fish)
        );
        assert_eq!(classify_remote_shell("/bin/tcsh\n"), None);
    }

    #[test]
    fn hides_chunked_and_repeated_osc7_setup_echoes_without_losing_banner() {
        let setup_command = osc7_setup_command(RemoteShell::Bash);
        let mut filter = TerminalOutputFilter::with_osc7_bootstrap(&setup_command);
        let echoed = format!("{setup_command}\r\n");
        let first_packet = format!("Welcome to Ubuntu\r\nroot@host:~#{echoed}");
        let split = first_packet.len() - 19;

        let first = filter.push(&first_packet.as_bytes()[..split]);
        assert_eq!(first.data, "Welcome to Ubuntu\r\n");

        let mut second_packet = first_packet.as_bytes()[split..].to_vec();
        second_packet.extend_from_slice(b"Startup completed after a slow profile\r\n");
        second_packet.extend_from_slice(format!("root@host:~#{echoed}").as_bytes());
        second_packet.extend_from_slice(b"\x1b]7;file:///root\x07");
        second_packet.extend_from_slice(OSC7_BOOTSTRAP_ACK);
        second_packet.extend_from_slice(b"root@host:~# ");
        let second = filter.push(&second_packet);

        assert_eq!(second.cwd.as_deref(), Some("/root"));
        assert!(second.osc7_ready);
        assert_eq!(
            second.data,
            "Startup completed after a slow profile\r\n\x1b]7;file:///root\x07root@host:~# "
        );
        assert!(!second.data.contains("__tdcwd"));
    }

    #[test]
    fn preserves_startup_output_when_setup_is_not_echoed() {
        let setup_command = osc7_setup_command(RemoteShell::Bash);
        let mut filter = TerminalOutputFilter::with_osc7_bootstrap(&setup_command);
        let mut packet = b"Welcome\r\n\x1b]7;file:///srv/app\x07".to_vec();
        packet.extend_from_slice(OSC7_BOOTSTRAP_ACK);
        packet.extend_from_slice(b"user@host:/srv/app$ ");

        let output = filter.push(&packet);

        assert_eq!(output.cwd.as_deref(), Some("/srv/app"));
        assert_eq!(
            output.data,
            "Welcome\r\n\x1b]7;file:///srv/app\x07user@host:/srv/app$ "
        );
    }
}
