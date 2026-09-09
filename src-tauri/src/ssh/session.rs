use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex as StdMutex},
};

use chrono::{Local, SecondsFormat};
use russh::{client, ChannelMsg, Disconnect, Pty};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::{
    sync::{mpsc, Mutex, Notify},
    time::{timeout, Duration},
};
use tokio_util::sync::CancellationToken;

use super::transport::{connect_route, ClientHandler, ConnectedRoute, HostKeyVerifier};
use super::{session_manager::SessionManager, SshError};
use crate::{
    audit::AuditRepository,
    error::CommandError,
    profile::{ProfileService, ResolvedProfileNode},
};

const SESSION_EVENT: &str = "xcontrol-session-message";
const COMPLETE_TIMEOUT: Duration = Duration::from_millis(400);
const PRE_ATTACH_OUTPUT_LIMIT: usize = 1024 * 1024;
const OSC7_SETUP: &str = concat!(
    r#" __tdcwd(){ printf "\033]7;file://%s\007\033]1337;RemoteUser=%s\007" "$(pwd -P 2>/dev/null)" "$(id -un 2>/dev/null)";};case "${PROMPT_COMMAND-}" in *__tdcwd*) ;; *) PROMPT_COMMAND="__tdcwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}";;esac;__tdcwd"#,
    "\n"
);

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
    Ping,
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
    host_key_decision: StdMutex<Option<String>>,
    host_key_notify: Notify,
    cancel: CancellationToken,
    commands: Mutex<Option<mpsc::Sender<SessionCommand>>>,
    pending_resize: StdMutex<Option<(u32, u32)>>,
    delivery: StdMutex<SessionDelivery>,
    app: AppHandle,
}

#[derive(Default)]
struct SessionDelivery {
    attached: bool,
    output_bytes: usize,
    messages: Vec<ClientMessage>,
}

impl Session {
    fn new(profile: &ResolvedProfileNode, app: AppHandle) -> Self {
        let id = uuid::Uuid::new_v4().to_string();
        let initial_log = ConnectionLogEntry {
            at: now_millis(),
            level: "info".into(),
            stage: "preparing".into(),
            message: "连接请求已创建，等待后端准备".into(),
        };
        Self {
            snapshot: StdMutex::new(SessionSnapshot {
                session_id: id.clone(),
                status: "connecting".into(),
                stage: "preparing".into(),
                message: initial_log.message.clone(),
                error: String::new(),
                waiting_for_host_key: false,
                host_key_fingerprint: String::new(),
                known_host_key_fingerprint: String::new(),
                logs: vec![initial_log],
                version: 1,
            }),
            id,
            profile_id: profile.profile_id.clone(),
            host: profile.host.clone(),
            username: profile.username.clone(),
            created_at: Local::now().to_rfc3339_opts(SecondsFormat::AutoSi, true),
            host_key_decision: StdMutex::new(None),
            host_key_notify: Notify::new(),
            cancel: CancellationToken::new(),
            commands: Mutex::new(None),
            pending_resize: StdMutex::new(None),
            delivery: StdMutex::new(SessionDelivery::default()),
            app,
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
        self.snapshot.lock().expect("session mutex poisoned").status = "connected".into();
        self.stage(stage, "info", message);
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
        self.stage(
            "hostkey_confirm",
            "warn",
            format!("{profile_name} 的主机指纹发生变化"),
        );
        {
            let mut snapshot = self.snapshot.lock().expect("session mutex poisoned");
            snapshot.waiting_for_host_key = true;
            snapshot.host_key_fingerprint = current.into();
            snapshot.known_host_key_fingerprint = known.into();
            snapshot.message = "检测到服务器主机指纹变化，等待确认".into();
            snapshot.version += 1;
        }
        self.emit_message("connection_state", "", Some(json!(self.snapshot())));
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

    fn emit_message(&self, message_type: &str, data: &str, payload: Option<Value>) {
        let message = ClientMessage {
            session_id: self.id.clone(),
            message_type: message_type.into(),
            data: data.into(),
            payload,
        };
        let should_emit = {
            let mut delivery = self.delivery.lock().expect("delivery mutex poisoned");
            if delivery.attached {
                true
            } else {
                match message_type {
                    "output" => {
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
                    // attach_messages reconstructs the latest connection state.
                    "connection_state" => {}
                    _ => delivery.messages.push(message.clone()),
                }
                false
            }
        };
        if should_emit {
            let _ = self.app.emit(SESSION_EVENT, message);
        }
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
            if known.is_empty() || known == current {
                return true;
            }
            self.session.host_key_prompt(current, known, profile_name);
            loop {
                tokio::select! {
                    _ = self.session.cancel.cancelled() => return false,
                    _ = self.session.host_key_notify.notified() => {
                        let decision = self.session.host_key_decision
                            .lock().expect("host key decision mutex poisoned").take();
                        if let Some(fingerprint) = decision {
                            if fingerprint == current {
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

#[derive(Clone)]
pub(crate) struct SshService {
    manager: SessionManager,
    profiles: ProfileService,
    audit: AuditRepository,
    app: AppHandle,
}

impl SshService {
    pub(crate) fn new(profiles: ProfileService, audit: AuditRepository, app: AppHandle) -> Self {
        Self {
            manager: SessionManager::default(),
            profiles,
            audit,
            app,
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
        let session = Arc::new(Session::new(&resolved, self.app.clone()));
        let response = SessionCreateResponse {
            session_id: session.id.clone(),
            status: "connecting".into(),
        };
        self.manager.register(session.clone()).await;
        session.stage("preparing", "info", "已读取连接配置，准备建立 SSH 会话");
        let state = self.clone();
        let cols = request.cols.filter(|value| *value > 0).unwrap_or(80);
        let rows = request.rows.filter(|value| *value > 0).unwrap_or(24);
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
            result = connect_route(resolved, verifier) => match result {
                Ok(route) => route,
                Err(error) => {
                    if !session.cancel.is_cancelled() {
                        session.failed("establishing_ssh", format!("SSH 握手或认证失败: {error}"));
                    }
                    return;
                }
            }
        };
        session.stage("establishing_ssh", "info", "SSH 握手完成，认证通过");
        session.stage("starting_shell", "info", "正在启动远程 Shell");
        if let Err(error) = self.run_terminal(session.clone(), route, cols, rows).await {
            if !session.cancel.is_cancelled() {
                session.failed("starting_shell", error.to_string());
            }
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

        session.connected("starting_shell", "远程 Shell 已启动，等待终端附着");
        for (profile_id, fingerprint) in &route.host_keys {
            let _ = self.profiles.persist_host_key(profile_id, fingerprint);
        }
        let _ = self.profiles.update_last_used(&session.profile_id);
        let _ = self.audit.record(&session.profile_id, "connect", "");
        session.connected("ready", "终端已就绪，开始接收远程输出");
        let metadata = session.metadata();
        session.emit_message(&metadata.message_type, &metadata.data, metadata.payload);
        channel
            .data_bytes(OSC7_SETUP.as_bytes().to_vec())
            .await
            .map_err(|error| format!("初始化终端目录跟踪: {error}"))?;

        let mut filter = TerminalOutputFilter::default();
        let mut exit_code = 0_u32;
        let mut normal_exit = false;
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
                    Some(SessionCommand::Ping) => {
                        let _ = timeout(Duration::from_secs(5), route.handle.send_ping()).await;
                        session.emit_message("pong", "", None);
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
                message = channel.wait() => match message {
                    Some(ChannelMsg::Data { data })
                    | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let output = filter.push(&data);
                        if let Some(cwd) = output.cwd {
                            session.emit_message("cwd", "", Some(json!({"path":cwd})));
                        }
                        if !output.data.is_empty() {
                            session.emit_message("output", &output.data, None);
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
            .expect("host key decision mutex poisoned") = Some(fingerprint);
        session.host_key_notify.notify_waiters();
        Ok(json!({"status":"accepted"}))
    }

    pub(crate) async fn input(&self, id: &str, data: String) -> Result<(), CommandError> {
        self.send_command(id, SessionCommand::Input(data)).await
    }

    pub(crate) async fn resize(&self, id: &str, cols: u32, rows: u32) -> Result<(), CommandError> {
        if cols == 0 || rows == 0 {
            return Ok(());
        }
        let session = self.manager.get(id).await?;
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
        self.send_command(id, SessionCommand::Ping).await
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

    pub(crate) async fn close(&self, id: &str) -> Result<(), CommandError> {
        self.manager.close(id).await
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
}

struct FilteredOutput {
    data: String,
    cwd: Option<String>,
}

impl TerminalOutputFilter {
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
        let mut data = String::from_utf8_lossy(&bytes).into_owned();
        for stale in [
            "-bash: 2004h: command not found\n",
            "-bash: 2004h: command not found\r\n",
            "-bash: 2004l: command not found\n",
            "-bash: 2004l: command not found\r\n",
        ] {
            data = data.replace(stale, "");
        }
        FilteredOutput { data, cwd }
    }
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
        assert!(OSC7_SETUP.contains("printf \"\\033]7;"));
        assert!(!OSC7_SETUP.contains("printf \\\\\""));
    }
}
