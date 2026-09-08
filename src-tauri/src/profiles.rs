//! SSH 连接配置领域：Profile CRUD、内联凭据、代理配置与跳板引用保护。
//!
//! 连接建立和 host-key 探测仍由尚未迁移的 SSH transport 承担；本模块不通过
//! HTTP 或 Go 写入业务数据。

use std::collections::HashSet;

use chrono::{Local, SecondsFormat};
use rusqlite::{params, params_from_iter, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::State;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::{
    credential_crypto::Encryptor,
    database::Database,
    error::CommandError,
    vault::{decode_plaintext, Credential, ProfileRef},
};

const MAX_JUMP_PROFILES: usize = 5;
const AUTH_PASSWORD: &str = "password";
const AUTH_KEY: &str = "key";
const AUTH_AGENT: &str = "agent";
const AUTH_VAULT: &str = "vault";
const PROXY_DIRECT: &str = "direct";
const PROXY_SOCKS5: &str = "socks5";
const PROXY_HTTP: &str = "http";
const PROXY_JUMP: &str = "jump";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProxyConfig {
    #[serde(rename = "type")]
    pub proxy_type: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub host: String,
    #[serde(default, skip_serializing_if = "is_zero_i64")]
    pub port: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub username: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub jump_profile_id: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_password: bool,
}

impl ProxyConfig {
    fn direct() -> Self {
        Self {
            proxy_type: PROXY_DIRECT.into(),
            host: String::new(),
            port: 0,
            username: String::new(),
            jump_profile_id: String::new(),
            has_password: false,
        }
    }
}

#[derive(Debug, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct ProxyInput {
    #[serde(default)]
    #[serde(rename = "type")]
    pub proxy_type: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: i64,
    #[serde(default)]
    pub username: String,
    pub password: Option<String>,
    #[serde(default)]
    pub jump_profile_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub auth_type: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub icon: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub vault_id: String,
    pub proxy: ProxyConfig,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub group_id: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub options: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
    pub sort_order: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip)]
    inline_credential: String,
    #[serde(skip)]
    proxy_credential: String,
}

/// SSH transport 所需的已解密连接节点。仅在 Rust 进程内存中存在，不参与序列化。
#[derive(Debug)]
pub(crate) struct ResolvedProfileNode {
    pub profile_id: String,
    pub profile_name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: String,
    pub private_key: String,
    pub passphrase: String,
    pub known_host_key: String,
    pub proxy_password: String,
    pub proxy: ProxyConfig,
    pub jump: Option<Box<ResolvedProfileNode>>,
}

impl Drop for ResolvedProfileNode {
    fn drop(&mut self) {
        self.password.zeroize();
        self.private_key.zeroize();
        self.passphrase.zeroize();
        self.proxy_password.zeroize();
    }
}

#[derive(Debug, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct ProfileCreateRequest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub auth_type: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub vault_id: String,
    #[serde(default)]
    pub password: String,
    #[serde(default, rename = "private_key")]
    pub private_key: String,
    #[serde(default)]
    pub passphrase: String,
    pub proxy: Option<ProxyInput>,
    #[serde(default)]
    pub group_id: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub options: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Default, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct ProfileUpdateRequest {
    pub name: Option<String>,
    pub host: Option<String>,
    pub port: Option<i64>,
    pub username: Option<String>,
    pub auth_type: Option<String>,
    pub icon: Option<String>,
    pub vault_id: Option<String>,
    pub password: Option<String>,
    #[serde(rename = "private_key")]
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub proxy: Option<ProxyInput>,
    pub group_id: Option<String>,
    pub tags: Option<Vec<String>>,
    pub options: Option<String>,
    pub note: Option<String>,
    #[serde(skip)]
    inline_credential: Option<String>,
    #[serde(skip)]
    proxy_credential: Option<String>,
}

#[derive(Clone)]
pub struct ProfileState {
    database: Database,
    encryptor: Encryptor,
}

impl ProfileState {
    pub fn initialize(database: Database, encryptor: Encryptor) -> Result<Self, CommandError> {
        let state = Self {
            database,
            encryptor,
        };
        state.backfill_inline_credentials()?;
        Ok(state)
    }

    pub(crate) fn list(
        &self,
        group_id: Option<&str>,
        search: Option<&str>,
    ) -> Result<Vec<Profile>, CommandError> {
        let connection = self.database.connect()?;
        let mut query = format!("{} WHERE 1=1", profile_select());
        let mut arguments = Vec::<String>::new();
        if let Some(group_id) = group_id.filter(|value| !value.is_empty()) {
            query.push_str(" AND group_id=?");
            arguments.push(group_id.to_owned());
        }
        if let Some(search) = search.filter(|value| !value.is_empty()) {
            query.push_str(" AND (name LIKE ? OR host LIKE ? OR note LIKE ?)");
            let pattern = format!("%{search}%");
            arguments.extend([pattern.clone(), pattern.clone(), pattern]);
        }
        query.push_str(" ORDER BY sort_order, name");
        let mut statement = connection.prepare(&query).map_err(CommandError::database)?;
        let rows = statement
            .query_map(params_from_iter(arguments.iter()), profile_from_row)
            .map_err(CommandError::database)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(CommandError::database)
    }

    pub(crate) fn get(&self, id: &str) -> Result<Profile, CommandError> {
        self.get_optional(id)?.ok_or_else(profile_not_found)
    }

    fn get_optional(&self, id: &str) -> Result<Option<Profile>, CommandError> {
        let connection = self.database.connect()?;
        connection
            .query_row(
                &format!("{} WHERE id=?1", profile_select()),
                [id],
                profile_from_row,
            )
            .optional()
            .map_err(CommandError::database)
    }

    pub(crate) fn resolve_connection(
        &self,
        profile_id: &str,
    ) -> Result<ResolvedProfileNode, CommandError> {
        let profile = self.get(profile_id)?;
        let mut visited = HashSet::new();
        self.resolve_node(profile, &mut visited, 0)
    }

    pub(crate) fn resolve_connection_draft_create(
        &self,
        mut request: ProfileCreateRequest,
    ) -> Result<ResolvedProfileNode, CommandError> {
        request.host = request.host.trim().to_owned();
        request.username = request.username.trim().to_owned();
        if request.host.is_empty() || request.username.is_empty() {
            return Err(CommandError::new("VALIDATION", "主机和用户名不能为空"));
        }
        if request.port == 0 {
            request.port = 22;
        }
        if request.auth_type.is_empty() {
            request.auth_type = AUTH_PASSWORD.into();
        }
        let id = format!("draft-{}", uuid::Uuid::new_v4());
        let proxy = normalize_proxy_input(request.proxy.as_ref())
            .map_err(|message| CommandError::new("INVALID_PROXY_CONFIG", message))?;
        self.validate_proxy_chain(&id, &proxy)
            .map_err(|message| CommandError::new("INVALID_PROXY_CHAIN", message))?;
        let options = with_proxy_options(&request.options, &proxy)
            .map_err(|_| CommandError::new("INVALID_OPTIONS", "连接高级配置不是有效 JSON"))?;
        let proxy_credential = self.prepare_proxy_on_create(request.proxy.as_ref(), &proxy)?;
        let (vault_id, inline_credential, username) =
            self.prepare_credential_on_create(&request)?;
        let now = now();
        let profile = Profile {
            id,
            name: request.name.clone(),
            host: request.host.clone(),
            port: i64::from(request.port),
            username,
            auth_type: request.auth_type.clone(),
            icon: request.icon.clone(),
            vault_id,
            proxy,
            group_id: request.group_id.clone(),
            tags: request.tags.clone(),
            options,
            note: request.note.clone(),
            sort_order: 0,
            last_used_at: None,
            created_at: now.clone(),
            updated_at: now,
            inline_credential,
            proxy_credential,
        };
        self.resolve_node(profile, &mut HashSet::new(), 0)
    }

    pub(crate) fn resolve_connection_draft_update(
        &self,
        profile_id: &str,
        mut request: ProfileUpdateRequest,
    ) -> Result<ResolvedProfileNode, CommandError> {
        let mut profile = self.get(profile_id)?;
        self.prepare_credential_on_update(&profile, &mut request)
            .map_err(|message| CommandError::new("VALIDATION", message))?;
        self.prepare_proxy_on_update(&profile, &mut request)
            .map_err(|message| CommandError::new("INVALID_PROXY_CONFIG", message))?;
        if let Some(value) = request.name.take() {
            profile.name = value;
        }
        if let Some(value) = request.host.take() {
            profile.host = value.trim().to_owned();
        }
        if let Some(value) = request.port {
            profile.port = value;
        }
        if let Some(value) = request.username.take() {
            profile.username = value.trim().to_owned();
        }
        if let Some(value) = request.auth_type.take() {
            profile.auth_type = value;
        }
        if let Some(value) = request.vault_id.take() {
            profile.vault_id = value;
        }
        if let Some(value) = request.inline_credential.take() {
            profile.inline_credential = value;
        }
        if let Some(value) = request.proxy_credential.take() {
            profile.proxy_credential = value;
        }
        if let Some(value) = request.options.take() {
            profile.options = value;
        }
        profile.proxy = parse_proxy_options(&profile.options);
        profile.proxy.has_password = !profile.proxy_credential.is_empty();
        if profile.host.is_empty() || profile.username.is_empty() {
            return Err(CommandError::new("VALIDATION", "主机和用户名不能为空"));
        }
        self.resolve_node(profile, &mut HashSet::new(), 0)
    }

    fn resolve_node(
        &self,
        profile: Profile,
        visited: &mut HashSet<String>,
        depth: usize,
    ) -> Result<ResolvedProfileNode, CommandError> {
        if depth > MAX_JUMP_PROFILES {
            return Err(CommandError::new(
                "INVALID_PROXY_CHAIN",
                format!("SSH 跳板链最多允许 {MAX_JUMP_PROFILES} 层"),
            ));
        }
        if !visited.insert(profile.id.clone()) {
            return Err(CommandError::new(
                "INVALID_PROXY_CHAIN",
                format!("SSH 跳板链存在循环引用，重复节点: {}", profile.name),
            ));
        }

        let credential = self.resolve_profile_credential(&profile).map_err(|error| {
            CommandError::new(
                "CREDENTIAL_ERROR",
                format!("读取 {} 的 SSH 凭据: {error}", profile.name),
            )
        })?;
        let proxy_password = if profile.proxy_credential.is_empty() {
            String::new()
        } else {
            self.encryptor
                .decrypt(&profile.proxy_credential)
                .map_err(|error| {
                    CommandError::new(
                        "CREDENTIAL_ERROR",
                        format!("读取 {} 的代理凭据: {error}", profile.name),
                    )
                })?
        };
        let jump = if profile.proxy.proxy_type == PROXY_JUMP {
            let jump_profile = self.get(&profile.proxy.jump_profile_id).map_err(|_| {
                CommandError::new(
                    "INVALID_PROXY_CHAIN",
                    format!("{} 引用的跳板机不存在", profile.name),
                )
            })?;
            Some(Box::new(self.resolve_node(
                jump_profile,
                visited,
                depth + 1,
            )?))
        } else {
            None
        };
        visited.remove(&profile.id);

        Ok(ResolvedProfileNode {
            profile_id: profile.id,
            profile_name: profile.name,
            host: profile.host,
            port: u16::try_from(profile.port).unwrap_or(22),
            username: profile.username,
            auth_type: profile.auth_type,
            password: credential.password.clone(),
            private_key: credential.private_key.clone(),
            passphrase: credential.passphrase.clone(),
            known_host_key: profile_host_key_fingerprint(&profile.options),
            proxy_password,
            proxy: profile.proxy,
            jump,
        })
    }

    pub(crate) fn persist_host_key(
        &self,
        profile_id: &str,
        fingerprint: &str,
    ) -> Result<(), CommandError> {
        let profile = self.get(profile_id)?;
        if profile_host_key_fingerprint(&profile.options) == fingerprint {
            return Ok(());
        }
        let options = with_profile_host_key_fingerprint(&profile.options, fingerprint)?;
        let connection = self.database.connect()?;
        connection
            .execute(
                "UPDATE profiles SET options=?1,updated_at=?2 WHERE id=?3",
                params![options, now(), profile_id],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub(crate) fn update_last_used(&self, profile_id: &str) -> Result<(), CommandError> {
        let connection = self.database.connect()?;
        connection
            .execute(
                "UPDATE profiles SET last_used_at=?1 WHERE id=?2",
                params![now(), profile_id],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    fn create(&self, mut request: ProfileCreateRequest) -> Result<Profile, CommandError> {
        request.name = request.name.trim().to_owned();
        request.host = request.host.trim().to_owned();
        request.username = request.username.trim().to_owned();
        if request.name.is_empty() || request.host.is_empty() {
            return Err(CommandError::new(
                "VALIDATION",
                "name and host are required",
            ));
        }
        if request.port == 0 {
            request.port = 22;
        }
        if request.auth_type.is_empty() {
            request.auth_type = AUTH_PASSWORD.into();
        }
        if request.icon.is_empty() {
            request.icon = "server".into();
        }

        let id = uuid::Uuid::new_v4().to_string();
        let proxy = normalize_proxy_input(request.proxy.as_ref())
            .map_err(|message| CommandError::new("INVALID_PROXY_CONFIG", message))?;
        self.validate_proxy_chain(&id, &proxy)
            .map_err(|message| CommandError::new("INVALID_PROXY_CHAIN", message))?;
        request.options = with_proxy_options(&request.options, &proxy)
            .map_err(|_| CommandError::new("INVALID_OPTIONS", "连接高级配置不是有效 JSON"))?;

        let proxy_credential = self.prepare_proxy_on_create(request.proxy.as_ref(), &proxy)?;
        let (vault_id, inline_credential, username) =
            self.prepare_credential_on_create(&request)?;
        if username.is_empty() {
            return Err(CommandError::new("VALIDATION", "username is required"));
        }
        let now = now();
        let tags = serde_json::to_string(&request.tags).unwrap_or_else(|_| "[]".into());
        let connection = self.database.connect()?;
        connection
            .execute(
                "INSERT INTO profiles \
                 (id,name,host,port,username,auth_type,icon,vault_id,inline_credential,\
                  proxy_credential,group_id,tags,options,note,sort_order,created_at,updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,0,?15,?15)",
                params![
                    id,
                    request.name,
                    request.host,
                    request.port,
                    username,
                    request.auth_type,
                    request.icon,
                    vault_id,
                    inline_credential,
                    proxy_credential,
                    request.group_id,
                    tags,
                    request.options,
                    request.note,
                    now,
                ],
            )
            .map_err(CommandError::database)?;
        self.get(&id)
    }

    fn update(&self, id: &str, mut request: ProfileUpdateRequest) -> Result<Profile, CommandError> {
        let current = self.get(id)?;
        self.prepare_credential_on_update(&current, &mut request)
            .map_err(|message| CommandError::new("VALIDATION", message))?;
        self.prepare_proxy_on_update(&current, &mut request)
            .map_err(|message| CommandError::new("INVALID_PROXY_CONFIG", message))?;

        let mut updated = current;
        if let Some(value) = request.name.take() {
            updated.name = value;
        }
        if let Some(value) = request.host.take() {
            updated.host = value;
        }
        if let Some(value) = request.port {
            updated.port = value;
        }
        if let Some(value) = request.username.take() {
            updated.username = value;
        }
        if let Some(value) = request.auth_type.take() {
            updated.auth_type = value;
        }
        if let Some(value) = request.icon.take() {
            updated.icon = value;
        }
        if let Some(value) = request.vault_id.take() {
            updated.vault_id = value;
        }
        if let Some(value) = request.inline_credential.take() {
            updated.inline_credential = value;
        }
        if let Some(value) = request.proxy_credential.take() {
            updated.proxy_credential = value;
        }
        if let Some(value) = request.group_id.take() {
            updated.group_id = value;
        }
        if let Some(value) = request.tags.take() {
            updated.tags = value;
        }
        if let Some(value) = request.options.take() {
            updated.options = value;
        }
        if let Some(value) = request.note.take() {
            updated.note = value;
        }
        updated.updated_at = now();
        let tags = serde_json::to_string(&updated.tags).unwrap_or_else(|_| "[]".into());
        let connection = self.database.connect()?;
        connection
            .execute(
                "UPDATE profiles SET name=?1,host=?2,port=?3,username=?4,auth_type=?5,icon=?6,\
                 vault_id=?7,inline_credential=?8,proxy_credential=?9,group_id=?10,tags=?11,\
                 options=?12,note=?13,updated_at=?14 WHERE id=?15",
                params![
                    updated.name,
                    updated.host,
                    updated.port,
                    updated.username,
                    updated.auth_type,
                    updated.icon,
                    updated.vault_id,
                    updated.inline_credential,
                    updated.proxy_credential,
                    updated.group_id,
                    tags,
                    updated.options,
                    updated.note,
                    updated.updated_at,
                    id,
                ],
            )
            .map_err(CommandError::database)?;
        self.get(id)
    }

    fn delete(&self, id: &str) -> Result<(), CommandError> {
        let mut connection = self.database.connect()?;
        let transaction = connection.transaction().map_err(CommandError::database)?;
        let references = jump_references(&transaction, id)?;
        if !references.is_empty() {
            return Err(CommandError::new(
                "PROFILE_IN_USE_AS_JUMP",
                "该连接正被其他服务器用作 SSH 跳板机",
            )
            .with_references(&references));
        }
        transaction
            .execute("DELETE FROM profiles WHERE id=?1", [id])
            .map_err(CommandError::database)?;
        transaction.commit().map_err(CommandError::database)
    }

    fn prepare_proxy_on_create(
        &self,
        input: Option<&ProxyInput>,
        proxy: &ProxyConfig,
    ) -> Result<String, CommandError> {
        let mut credential = String::new();
        if let Some(password) = input.and_then(|value| value.password.as_deref()) {
            if !proxy.username.is_empty() && password.is_empty() {
                return Err(CommandError::new(
                    "INVALID_PROXY_CONFIG",
                    "代理用户名和密码必须同时填写",
                ));
            }
            credential = self
                .encode_proxy_password(password)
                .map_err(|message| CommandError::new("ENCRYPT_FAILED", message))?;
        }
        if !proxy.username.is_empty() && credential.is_empty() {
            return Err(CommandError::new(
                "INVALID_PROXY_CONFIG",
                "代理用户名和密码必须同时填写",
            ));
        }
        Ok(credential)
    }

    fn prepare_proxy_on_update(
        &self,
        current: &Profile,
        request: &mut ProfileUpdateRequest,
    ) -> Result<(), String> {
        let Some(input) = request.proxy.as_ref() else {
            if let Some(options) = request.options.as_ref() {
                request.options = Some(
                    with_proxy_options(options, &current.proxy)
                        .map_err(|_| "连接高级配置不是有效 JSON".to_owned())?,
                );
            }
            return Ok(());
        };

        let next = normalize_proxy_input(Some(input))?;
        self.validate_proxy_chain(&current.id, &next)?;
        let raw_options = request.options.as_deref().unwrap_or(&current.options);
        request.options = Some(
            with_proxy_options(raw_options, &next)
                .map_err(|_| "连接高级配置不是有效 JSON".to_owned())?,
        );

        let mut credential = current.proxy_credential.clone();
        if next.proxy_type == PROXY_DIRECT || next.proxy_type == PROXY_JUMP {
            credential.clear();
        } else if let Some(password) = input.password.as_deref() {
            if password.is_empty() {
                credential.clear();
            } else {
                credential = self.encode_proxy_password(password)?;
            }
        } else if !same_proxy_identity(&current.proxy, &next) {
            credential.clear();
        }
        if next.username.is_empty() {
            credential.clear();
        } else if credential.is_empty() {
            return Err("代理用户名和密码必须同时填写".into());
        }
        request.proxy_credential = Some(credential);
        Ok(())
    }

    fn prepare_credential_on_create(
        &self,
        request: &ProfileCreateRequest,
    ) -> Result<(String, String, String), CommandError> {
        match request.auth_type.as_str() {
            AUTH_VAULT => {
                if request.vault_id.is_empty() {
                    return Err(CommandError::new(
                        "VALIDATION",
                        "vault_id is required for vault auth",
                    ));
                }
                let (entry_type, vault_username) = self
                    .vault_metadata(&request.vault_id)
                    .map_err(|_| CommandError::new("VALIDATION", "vault entry not found"))?;
                let username =
                    apply_vault_username(&entry_type, &vault_username, &request.username)
                        .map_err(|message| CommandError::new("VALIDATION", message))?;
                Ok((request.vault_id.clone(), String::new(), username))
            }
            AUTH_PASSWORD => {
                if request.username.is_empty() {
                    return Err(CommandError::new("VALIDATION", "username is required"));
                }
                if request.password.is_empty() {
                    return Err(CommandError::new(
                        "VALIDATION",
                        "password is required for password auth",
                    ));
                }
                let credential = Credential {
                    password: request.password.clone(),
                    private_key: String::new(),
                    public_key: String::new(),
                    passphrase: String::new(),
                };
                Ok((
                    String::new(),
                    self.encode_inline_credential(&credential)
                        .map_err(|message| CommandError::new("VALIDATION", message))?,
                    request.username.clone(),
                ))
            }
            AUTH_KEY => {
                if request.username.is_empty() {
                    return Err(CommandError::new("VALIDATION", "username is required"));
                }
                if request.private_key.is_empty() {
                    return Err(CommandError::new(
                        "VALIDATION",
                        "private_key is required for key auth",
                    ));
                }
                let credential = Credential {
                    password: String::new(),
                    private_key: request.private_key.clone(),
                    public_key: String::new(),
                    passphrase: request.passphrase.clone(),
                };
                Ok((
                    String::new(),
                    self.encode_inline_credential(&credential)
                        .map_err(|message| CommandError::new("VALIDATION", message))?,
                    request.username.clone(),
                ))
            }
            AUTH_AGENT => {
                if request.username.is_empty() {
                    return Err(CommandError::new("VALIDATION", "username is required"));
                }
                Ok((String::new(), String::new(), request.username.clone()))
            }
            other => Err(CommandError::new(
                "VALIDATION",
                format!("unsupported auth_type: {other}"),
            )),
        }
    }

    fn prepare_credential_on_update(
        &self,
        current: &Profile,
        request: &mut ProfileUpdateRequest,
    ) -> Result<(), String> {
        let next_auth_type = request
            .auth_type
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(&current.auth_type)
            .to_owned();
        let mut next_username = current.username.trim().to_owned();
        let mut requested_username = String::new();
        if let Some(username) = request.username.as_mut() {
            *username = username.trim().to_owned();
            next_username.clone_from(username);
            requested_username.clone_from(username);
        }

        match next_auth_type.as_str() {
            AUTH_VAULT => {
                let vault_id = match request.vault_id.as_deref() {
                    Some("") => return Err("vault_id is required for vault auth".into()),
                    Some(value) => value.to_owned(),
                    None if current.vault_id.is_empty() => {
                        return Err("vault_id is required for vault auth".into())
                    }
                    None => current.vault_id.clone(),
                };
                let (entry_type, vault_username) = self
                    .vault_metadata(&vault_id)
                    .map_err(|_| "vault entry not found".to_owned())?;
                let requested = if entry_type == AUTH_PASSWORD {
                    requested_username
                } else {
                    next_username
                };
                request.username = Some(apply_vault_username(
                    &entry_type,
                    &vault_username,
                    &requested,
                )?);
                request.inline_credential = Some(String::new());
            }
            AUTH_PASSWORD | AUTH_KEY | AUTH_AGENT => {
                if next_username.is_empty() {
                    return Err("username is required".into());
                }
                let mut credential = self.resolve_profile_credential(current)?;
                match next_auth_type.as_str() {
                    AUTH_PASSWORD => {
                        if let Some(password) = request.password.as_deref() {
                            if !password.is_empty() {
                                credential.password = password.to_owned();
                            }
                        }
                        if credential.password.is_empty() {
                            return Err("password is required for password auth".into());
                        }
                        credential.private_key.clear();
                        credential.passphrase.clear();
                    }
                    AUTH_KEY => {
                        if let Some(private_key) = request.private_key.as_deref() {
                            if !private_key.is_empty() {
                                credential.private_key = private_key.to_owned();
                            }
                        }
                        if let Some(passphrase) = request.passphrase.as_deref() {
                            credential.passphrase = passphrase.to_owned();
                        }
                        if credential.private_key.is_empty() {
                            return Err("private_key is required for key auth".into());
                        }
                        credential.password.clear();
                    }
                    AUTH_AGENT => credential = Credential::default(),
                    _ => unreachable!(),
                }
                request.inline_credential = Some(self.encode_inline_credential(&credential)?);
                request.vault_id = Some(String::new());
            }
            other => return Err(format!("unsupported auth_type: {other}")),
        }
        Ok(())
    }

    fn resolve_profile_credential(&self, profile: &Profile) -> Result<Credential, String> {
        if profile.auth_type == AUTH_VAULT && !profile.vault_id.is_empty() {
            return self
                .retrieve_vault(&profile.vault_id)
                .map_err(|error| format!("retrieve vault credential: {error}"));
        }
        if !profile.inline_credential.is_empty() {
            return self
                .decode_inline_credential(&profile.inline_credential)
                .map_err(|error| format!("decode inline credential: {error}"));
        }
        if !profile.vault_id.is_empty() {
            return self
                .retrieve_vault(&profile.vault_id)
                .map_err(|error| format!("retrieve legacy vault credential: {error}"));
        }
        Ok(Credential::default())
    }

    fn vault_metadata(&self, id: &str) -> Result<(String, String), CommandError> {
        let connection = self.database.connect()?;
        connection
            .query_row(
                "SELECT type, COALESCE(username,'') FROM vault WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(CommandError::database)?
            .ok_or_else(|| CommandError::new("NOT_FOUND", "vault entry not found"))
    }

    fn retrieve_vault(&self, id: &str) -> Result<Credential, String> {
        let connection = self.database.connect().map_err(|error| error.message)?;
        let (entry_type, data): (String, String) = connection
            .query_row("SELECT type,data FROM vault WHERE id=?1", [id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(|error| error.to_string())?;
        let plaintext = self
            .encryptor
            .decrypt(&data)
            .map_err(|error| error.to_string())?;
        Ok(decode_plaintext(&plaintext, &entry_type))
    }

    fn encode_inline_credential(&self, credential: &Credential) -> Result<String, String> {
        let raw = serde_json::to_string(credential)
            .map_err(|error| format!("marshal inline credential: {error}"))?;
        if raw == "{}" {
            return Ok(String::new());
        }
        self.encryptor
            .encrypt(&raw)
            .map_err(|error| format!("encrypt inline credential: {error}"))
    }

    fn decode_inline_credential(&self, encoded: &str) -> Result<Credential, String> {
        if encoded.is_empty() {
            return Ok(Credential::default());
        }
        let decrypted = self
            .encryptor
            .decrypt(encoded)
            .map_err(|error| format!("decrypt inline credential: {error}"))?;
        serde_json::from_str(&decrypted)
            .map_err(|error| format!("unmarshal inline credential: {error}"))
    }

    fn encode_proxy_password(&self, password: &str) -> Result<String, String> {
        if password.is_empty() {
            return Ok(String::new());
        }
        self.encryptor
            .encrypt(password)
            .map_err(|error| format!("加密代理密码: {error}"))
    }

    fn validate_proxy_chain(&self, root_id: &str, root: &ProxyConfig) -> Result<(), String> {
        let mut visited = HashSet::from([root_id.to_owned()]);
        let mut path = vec![root_id.to_owned()];
        let mut proxy = root.clone();
        let mut depth = 0;
        while proxy.proxy_type == PROXY_JUMP {
            if depth >= MAX_JUMP_PROFILES {
                return Err(format!("SSH 跳板链最多允许 {MAX_JUMP_PROFILES} 层"));
            }
            let next_id = proxy.jump_profile_id.clone();
            if visited.contains(&next_id) {
                path.push(next_id);
                return Err(format!("SSH 跳板链存在循环引用: {}", path.join(" -> ")));
            }
            let next = self
                .get_optional(&next_id)
                .map_err(|error| error.message)?
                .ok_or_else(|| format!("跳板机 Profile 不存在: {next_id}"))?;
            visited.insert(next_id.clone());
            path.push(next_id);
            proxy = next.proxy;
            depth += 1;
        }
        Ok(())
    }

    fn backfill_inline_credentials(&self) -> Result<(), CommandError> {
        let connection = self.database.connect()?;
        let mut statement = connection
            .prepare(
                "SELECT p.id,p.auth_type,p.vault_id,v.type,v.data FROM profiles p \
                 JOIN vault v ON v.id=p.vault_id WHERE p.auth_type!='vault' \
                 AND p.vault_id!='' AND (p.inline_credential='' OR p.inline_credential IS NULL)",
            )
            .map_err(CommandError::database)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(CommandError::database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(CommandError::database)?;
        drop(statement);
        for (id, _auth_type, vault_id, vault_type, data) in rows {
            let plaintext = self.encryptor.decrypt(&data).map_err(|error| {
                CommandError::new(
                    "DB_ERROR",
                    format!("decrypt legacy vault credential for profile {id}: {error}"),
                )
            })?;
            let credential = decode_plaintext(&plaintext, &vault_type);
            let inline = self
                .encode_inline_credential(&credential)
                .map_err(|error| {
                    CommandError::new(
                        "DB_ERROR",
                        format!("encode inline credential for profile {id}: {error}"),
                    )
                })?;
            connection
                .execute(
                    "UPDATE profiles SET inline_credential=?1,vault_id='',\
                     updated_at=CURRENT_TIMESTAMP WHERE id=?2",
                    params![inline, id],
                )
                .map_err(CommandError::database)?;
            let references: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM profiles WHERE auth_type='vault' AND vault_id=?1",
                    [&vault_id],
                    |row| row.get(0),
                )
                .map_err(CommandError::database)?;
            if references == 0 {
                connection
                    .execute("DELETE FROM vault WHERE id=?1", [&vault_id])
                    .map_err(CommandError::database)?;
            }
        }
        Ok(())
    }
}

fn profile_select() -> &'static str {
    "SELECT id,name,host,port,username,auth_type,COALESCE(icon,''),COALESCE(vault_id,''),\
     COALESCE(inline_credential,''),COALESCE(proxy_credential,''),COALESCE(group_id,''),\
     COALESCE(tags,'[]'),COALESCE(options,'{}'),COALESCE(note,''),COALESCE(sort_order,0),\
     last_used_at,created_at,updated_at FROM profiles"
}

fn profile_from_row(row: &Row<'_>) -> rusqlite::Result<Profile> {
    let tags_json: String = row.get(11)?;
    let tags = serde_json::from_str(&tags_json).unwrap_or_default();
    let options: String = row.get(12)?;
    let proxy_credential: String = row.get(9)?;
    let mut proxy = parse_proxy_options(&options);
    proxy.has_password = !proxy_credential.is_empty();
    Ok(Profile {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        port: row.get(3)?,
        username: row.get(4)?,
        auth_type: row.get(5)?,
        icon: row.get(6)?,
        vault_id: row.get(7)?,
        inline_credential: row.get(8)?,
        proxy_credential,
        proxy,
        group_id: row.get(10)?,
        tags,
        options,
        note: row.get(13)?,
        sort_order: row.get(14)?,
        last_used_at: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

fn profile_host_key_fingerprint(raw: &str) -> String {
    serde_json::from_str::<Map<String, Value>>(raw)
        .ok()
        .and_then(|options| {
            options
                .get("host_key_fingerprint")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default()
}

fn with_profile_host_key_fingerprint(raw: &str, fingerprint: &str) -> Result<String, CommandError> {
    let mut options = if raw.trim().is_empty() {
        Map::new()
    } else {
        serde_json::from_str::<Map<String, Value>>(raw)
            .map_err(|_| CommandError::new("INVALID_OPTIONS", "连接高级配置配置不是有效 JSON"))?
    };
    if fingerprint.is_empty() {
        options.remove("host_key_fingerprint");
    } else {
        options.insert(
            "host_key_fingerprint".into(),
            Value::String(fingerprint.into()),
        );
    }
    serde_json::to_string(&options)
        .map_err(|error| CommandError::new("INVALID_OPTIONS", error.to_string()))
}

fn normalize_proxy_input(input: Option<&ProxyInput>) -> Result<ProxyConfig, String> {
    let Some(input) = input else {
        return Ok(ProxyConfig::direct());
    };
    let proxy_type = input.proxy_type.trim();
    if proxy_type.is_empty() || proxy_type == PROXY_DIRECT {
        return Ok(ProxyConfig::direct());
    }
    let mut proxy = ProxyConfig {
        proxy_type: proxy_type.to_owned(),
        host: input.host.trim().to_owned(),
        port: input.port,
        username: input.username.trim().to_owned(),
        jump_profile_id: input.jump_profile_id.trim().to_owned(),
        has_password: false,
    };
    match proxy.proxy_type.as_str() {
        PROXY_SOCKS5 | PROXY_HTTP => {
            if proxy.host.is_empty() {
                return Err("代理主机不能为空".into());
            }
            if proxy.port == 0 {
                proxy.port = if proxy.proxy_type == PROXY_SOCKS5 {
                    1080
                } else {
                    8080
                };
            }
            if !(1..=65535).contains(&proxy.port) {
                return Err("代理端口必须在 1 到 65535 之间".into());
            }
            if input
                .password
                .as_deref()
                .is_some_and(|value| !value.is_empty())
                && proxy.username.is_empty()
            {
                return Err("填写代理密码时必须同时填写用户名".into());
            }
        }
        PROXY_JUMP => {
            if proxy.jump_profile_id.is_empty() {
                return Err("请选择 SSH 跳板机".into());
            }
            proxy.host.clear();
            proxy.port = 0;
            proxy.username.clear();
        }
        other => return Err(format!("不支持的代理类型: {other}")),
    }
    Ok(proxy)
}

fn parse_proxy_options(raw: &str) -> ProxyConfig {
    if raw.trim().is_empty() {
        return ProxyConfig::direct();
    }
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return ProxyConfig::direct();
    };
    let Some(proxy_value) = value.get("proxy") else {
        return ProxyConfig::direct();
    };
    let Ok(mut proxy) = serde_json::from_value::<ProxyConfig>(proxy_value.clone()) else {
        return ProxyConfig::direct();
    };
    if proxy.proxy_type.is_empty() {
        proxy.proxy_type = PROXY_DIRECT.into();
    }
    proxy.has_password = false;
    proxy
}

fn with_proxy_options(raw: &str, proxy: &ProxyConfig) -> Result<String, serde_json::Error> {
    let raw = if raw.trim().is_empty() { "{}" } else { raw };
    let mut options = serde_json::from_str::<Map<String, Value>>(raw)?;
    if proxy.proxy_type.is_empty() || proxy.proxy_type == PROXY_DIRECT {
        options.remove("proxy");
    } else {
        let mut persisted = proxy.clone();
        persisted.has_password = false;
        options.insert("proxy".into(), serde_json::to_value(persisted)?);
    }
    serde_json::to_string(&options)
}

fn same_proxy_identity(left: &ProxyConfig, right: &ProxyConfig) -> bool {
    left.proxy_type == right.proxy_type
        && left.host == right.host
        && left.port == right.port
        && left.username == right.username
        && left.jump_profile_id == right.jump_profile_id
}

fn apply_vault_username(
    entry_type: &str,
    vault_username: &str,
    requested_username: &str,
) -> Result<String, String> {
    let requested = requested_username.trim();
    if entry_type != AUTH_PASSWORD {
        return if requested.is_empty() {
            Err("username is required".into())
        } else {
            Ok(requested.into())
        };
    }
    let vault_username = vault_username.trim();
    if vault_username.is_empty() {
        return Err(
            "password vault username is missing; update the vault entry before using it".into(),
        );
    }
    if !requested.is_empty() && requested != vault_username {
        return Err("username must match the password vault username".into());
    }
    Ok(vault_username.into())
}

fn jump_references(
    transaction: &Transaction<'_>,
    profile_id: &str,
) -> Result<Vec<ProfileRef>, CommandError> {
    let mut statement = transaction
        .prepare("SELECT id,name,COALESCE(options,'{}') FROM profiles ORDER BY sort_order,name")
        .map_err(CommandError::database)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(CommandError::database)?;
    let mut references = Vec::new();
    for row in rows {
        let (id, name, options) = row.map_err(CommandError::database)?;
        let proxy = parse_proxy_options(&options);
        if proxy.proxy_type == PROXY_JUMP && proxy.jump_profile_id == profile_id {
            references.push(ProfileRef { id, name });
        }
    }
    Ok(references)
}

fn is_zero_i64(value: &i64) -> bool {
    *value == 0
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn now() -> String {
    Local::now().to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

fn profile_not_found() -> CommandError {
    CommandError::new("NOT_FOUND", "profile not found")
}

#[tauri::command]
pub async fn profile_list(
    state: State<'_, ProfileState>,
    group_id: Option<String>,
    search: Option<String>,
) -> Result<Vec<Profile>, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.list(group_id.as_deref(), search.as_deref()))
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub async fn profile_get(
    state: State<'_, ProfileState>,
    id: String,
) -> Result<Profile, CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.get(&id))
        .await
        .map_err(CommandError::database)?
}

#[tauri::command]
pub async fn profile_create(
    state: State<'_, ProfileState>,
    sync_state: State<'_, crate::sync::SyncState>,
    request: ProfileCreateRequest,
) -> Result<Profile, CommandError> {
    let state = state.inner().clone();
    let profile = tauri::async_runtime::spawn_blocking(move || state.create(request))
        .await
        .map_err(CommandError::database)??;
    sync_state.notify_change();
    Ok(profile)
}

#[tauri::command]
pub async fn profile_update(
    state: State<'_, ProfileState>,
    sync_state: State<'_, crate::sync::SyncState>,
    id: String,
    request: ProfileUpdateRequest,
) -> Result<Profile, CommandError> {
    let state = state.inner().clone();
    let profile = tauri::async_runtime::spawn_blocking(move || state.update(&id, request))
        .await
        .map_err(CommandError::database)??;
    sync_state.notify_change();
    Ok(profile)
}

#[tauri::command]
pub async fn profile_delete(
    state: State<'_, ProfileState>,
    sync_state: State<'_, crate::sync::SyncState>,
    id: String,
) -> Result<(), CommandError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.delete(&id))
        .await
        .map_err(CommandError::database)??;
    sync_state.notify_change();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (tempfile::TempDir, ProfileState) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::initialize(directory.path().join("xcontrol.db")).unwrap();
        let encryptor = Encryptor::load_or_create(directory.path().join("key")).unwrap();
        let state = ProfileState::initialize(database, encryptor).unwrap();
        (directory, state)
    }

    fn password_request(name: &str) -> ProfileCreateRequest {
        ProfileCreateRequest {
            name: name.into(),
            host: " example.com ".into(),
            port: 0,
            username: " root ".into(),
            auth_type: AUTH_PASSWORD.into(),
            icon: String::new(),
            vault_id: String::new(),
            password: "secret".into(),
            private_key: String::new(),
            passphrase: String::new(),
            proxy: None,
            group_id: String::new(),
            tags: Vec::new(),
            options: String::new(),
            note: String::new(),
        }
    }

    #[test]
    fn password_crud_defaults_filters_and_secrets_are_not_returned() {
        let (_directory, state) = state();
        let profile = state.create(password_request(" web ")).unwrap();
        assert_eq!(profile.name, "web");
        assert_eq!(profile.host, "example.com");
        assert_eq!(profile.port, 22);
        assert_eq!(profile.username, "root");
        assert_eq!(profile.icon, "server");
        assert_eq!(profile.options, "{}");
        assert_eq!(profile.proxy, ProxyConfig::direct());
        assert!(!profile.inline_credential.is_empty());
        assert_eq!(
            state.list(None, Some("example")).unwrap(),
            vec![profile.clone()]
        );

        let mut update = ProfileUpdateRequest::default();
        update.name = Some("数据库".into());
        update.note = Some("生产".into());
        let updated = state.update(&profile.id, update).unwrap();
        assert_eq!(updated.name, "数据库");
        assert_eq!(state.list(None, Some("生产")).unwrap().len(), 1);
        state.delete(&profile.id).unwrap();
        assert_eq!(state.get(&profile.id).unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn vault_username_rules_and_inline_auth_transitions_match_go() {
        let (_directory, state) = state();
        let encrypted = state.encryptor.encrypt("vault-secret").unwrap();
        state
            .database
            .connect()
            .unwrap()
            .execute(
                "INSERT INTO vault (id,type,data,name,username) \
                 VALUES ('v1','password',?1,'root vault','admin')",
                [encrypted],
            )
            .unwrap();
        let mut request = password_request("vault profile");
        request.auth_type = AUTH_VAULT.into();
        request.vault_id = "v1".into();
        request.username.clear();
        request.password.clear();
        let profile = state.create(request).unwrap();
        assert_eq!(profile.username, "admin");
        assert!(profile.inline_credential.is_empty());

        let mut update = ProfileUpdateRequest::default();
        update.auth_type = Some(AUTH_PASSWORD.into());
        let transitioned = state.update(&profile.id, update).unwrap();
        assert!(transitioned.vault_id.is_empty());
        assert_eq!(
            state
                .decode_inline_credential(&transitioned.inline_credential)
                .unwrap()
                .password,
            "vault-secret"
        );
    }

    #[test]
    fn proxy_password_preservation_and_jump_delete_guard_are_atomic() {
        let (_directory, state) = state();
        let jump = state.create(password_request("jump")).unwrap();
        let mut request = password_request("target");
        request.proxy = Some(ProxyInput {
            proxy_type: PROXY_JUMP.into(),
            host: "ignored".into(),
            port: 123,
            username: "ignored".into(),
            password: None,
            jump_profile_id: jump.id.clone(),
        });
        let target = state.create(request).unwrap();
        assert_eq!(target.proxy.proxy_type, PROXY_JUMP);
        assert_eq!(target.proxy.jump_profile_id, jump.id);
        let error = state.delete(&jump.id).unwrap_err();
        assert_eq!(error.code, "PROFILE_IN_USE_AS_JUMP");
        assert!(error.references.is_some());

        let mut proxy_request = password_request("proxy");
        proxy_request.proxy = Some(ProxyInput {
            proxy_type: PROXY_SOCKS5.into(),
            host: " proxy.local ".into(),
            port: 0,
            username: " alice ".into(),
            password: Some("proxy-secret".into()),
            jump_profile_id: String::new(),
        });
        let proxied = state.create(proxy_request).unwrap();
        assert_eq!(proxied.proxy.port, 1080);
        assert!(proxied.proxy.has_password);
        let encrypted = proxied.proxy_credential.clone();
        let mut update = ProfileUpdateRequest::default();
        update.proxy = Some(ProxyInput {
            proxy_type: PROXY_SOCKS5.into(),
            host: "proxy.local".into(),
            port: 1080,
            username: "alice".into(),
            password: None,
            jump_profile_id: String::new(),
        });
        let unchanged = state.update(&proxied.id, update).unwrap();
        assert_eq!(unchanged.proxy_credential, encrypted);
    }

    #[test]
    fn proxy_chain_rejects_cycles_missing_nodes_and_depth() {
        let (_directory, state) = state();
        let connection = state.database.connect().unwrap();
        for index in 0..=MAX_JUMP_PROFILES {
            let id = format!("p{index}");
            let next = format!("p{}", index + 1);
            let options = with_proxy_options(
                "{}",
                &ProxyConfig {
                    proxy_type: PROXY_JUMP.into(),
                    host: String::new(),
                    port: 0,
                    username: String::new(),
                    jump_profile_id: next,
                    has_password: false,
                },
            )
            .unwrap();
            connection
                .execute(
                    "INSERT INTO profiles (id,name,host,options) VALUES (?1,?1,'host',?2)",
                    params![id, options],
                )
                .unwrap();
        }
        drop(connection);
        let error = state
            .validate_proxy_chain(
                "root",
                &ProxyConfig {
                    proxy_type: PROXY_JUMP.into(),
                    host: String::new(),
                    port: 0,
                    username: String::new(),
                    jump_profile_id: "p0".into(),
                    has_password: false,
                },
            )
            .unwrap_err();
        assert!(error.contains("最多"), "{error}");
        assert!(state
            .validate_proxy_chain(
                "root",
                &ProxyConfig {
                    proxy_type: PROXY_JUMP.into(),
                    host: String::new(),
                    port: 0,
                    username: String::new(),
                    jump_profile_id: "missing".into(),
                    has_password: false,
                },
            )
            .unwrap_err()
            .contains("不存在"));
    }

    #[test]
    fn legacy_non_vault_credentials_are_backfilled_and_orphans_removed() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::initialize(directory.path().join("xcontrol.db")).unwrap();
        let encryptor = Encryptor::load_or_create(directory.path().join("key")).unwrap();
        let data = encryptor.encrypt("legacy-password").unwrap();
        let connection = database.connect().unwrap();
        connection
            .execute(
                "INSERT INTO vault (id,type,data,name) VALUES ('legacy','password',?1,'legacy')",
                [data],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO profiles (id,name,host,auth_type,vault_id) \
                 VALUES ('profile','legacy','host','password','legacy')",
                [],
            )
            .unwrap();
        drop(connection);
        let state = ProfileState::initialize(database.clone(), encryptor).unwrap();
        let profile = state.get("profile").unwrap();
        assert!(profile.vault_id.is_empty());
        assert_eq!(
            state
                .decode_inline_credential(&profile.inline_credential)
                .unwrap()
                .password,
            "legacy-password"
        );
        let count: i64 = database
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM vault WHERE id='legacy'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}
