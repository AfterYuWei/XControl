//! SSH 连接配置领域：Profile CRUD、内联凭据、代理配置与跳板引用保护。
//!
//! 连接建立和 host-key 探测仍由尚未迁移的 SSH transport 承担；本模块不通过
//! HTTP 或 Go 写入业务数据。

use std::collections::HashSet;

use chrono::{Local, SecondsFormat};

use crate::{
    error::CommandError,
    infrastructure::database::Database,
    vault::{Credential, Encryptor, VaultService},
};

use super::{
    connection::{
        normalize_proxy_input, parse_proxy_options, profile_host_key_fingerprint,
        same_proxy_identity, with_profile_host_key_fingerprint, with_proxy_options, PROXY_DIRECT,
        PROXY_JUMP,
    },
    error::ProfileError,
    repository::ProfileRepository,
    Profile, ProfileCreateRequest, ProfileUpdateRequest, ProxyConfig, ProxyInput,
    ResolvedProfileNode,
};

const MAX_JUMP_PROFILES: usize = 5;
const AUTH_PASSWORD: &str = "password";
const AUTH_KEY: &str = "key";
const AUTH_AGENT: &str = "agent";
const AUTH_VAULT: &str = "vault";

#[derive(Clone)]
pub(crate) struct ProfileService {
    repository: ProfileRepository,
    encryptor: Encryptor,
    vault: VaultService,
}

impl ProfileService {
    pub fn initialize(
        database: Database,
        encryptor: Encryptor,
        vault: VaultService,
    ) -> Result<Self, CommandError> {
        super::legacy::backfill_inline_credentials(&database, &encryptor)?;
        let state = Self {
            repository: ProfileRepository::new(database),
            encryptor,
            vault,
        };
        Ok(state)
    }

    pub(crate) fn list(
        &self,
        group_id: Option<&str>,
        search: Option<&str>,
    ) -> Result<Vec<Profile>, CommandError> {
        self.repository.list(group_id, search)
    }

    pub(crate) fn get(&self, id: &str) -> Result<Profile, CommandError> {
        self.get_optional(id)?.ok_or_else(profile_not_found)
    }

    fn get_optional(&self, id: &str) -> Result<Option<Profile>, CommandError> {
        self.repository.get(id)
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
            .map_err(|error| CommandError::new("INVALID_PROXY_CONFIG", error.to_string()))?;
        self.validate_proxy_chain(&id, &proxy)
            .map_err(|error| CommandError::new("INVALID_PROXY_CHAIN", error.to_string()))?;
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
            .map_err(|error| CommandError::new("VALIDATION", error.to_string()))?;
        self.prepare_proxy_on_update(&profile, &mut request)
            .map_err(|error| CommandError::new("INVALID_PROXY_CONFIG", error.to_string()))?;
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
        self.repository.update_options(profile_id, &options, &now())
    }

    pub(crate) fn update_last_used(&self, profile_id: &str) -> Result<(), CommandError> {
        self.repository.update_last_used(profile_id, &now())
    }

    pub(crate) fn create(
        &self,
        mut request: ProfileCreateRequest,
    ) -> Result<Profile, CommandError> {
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
            .map_err(|error| CommandError::new("INVALID_PROXY_CONFIG", error.to_string()))?;
        self.validate_proxy_chain(&id, &proxy)
            .map_err(|error| CommandError::new("INVALID_PROXY_CHAIN", error.to_string()))?;
        request.options = with_proxy_options(&request.options, &proxy)
            .map_err(|_| CommandError::new("INVALID_OPTIONS", "连接高级配置不是有效 JSON"))?;

        let proxy_credential = self.prepare_proxy_on_create(request.proxy.as_ref(), &proxy)?;
        let (vault_id, inline_credential, username) =
            self.prepare_credential_on_create(&request)?;
        if username.is_empty() {
            return Err(CommandError::new("VALIDATION", "username is required"));
        }
        let now = now();
        let profile = Profile {
            id: id.clone(),
            name: std::mem::take(&mut request.name),
            host: std::mem::take(&mut request.host),
            port: i64::from(request.port),
            username,
            auth_type: std::mem::take(&mut request.auth_type),
            icon: std::mem::take(&mut request.icon),
            vault_id,
            proxy,
            group_id: std::mem::take(&mut request.group_id),
            tags: std::mem::take(&mut request.tags),
            options: std::mem::take(&mut request.options),
            note: std::mem::take(&mut request.note),
            sort_order: 0,
            last_used_at: None,
            created_at: now.clone(),
            updated_at: now,
            inline_credential,
            proxy_credential,
        };
        self.repository.insert(&profile)?;
        self.get(&id)
    }

    pub(crate) fn update(
        &self,
        id: &str,
        mut request: ProfileUpdateRequest,
    ) -> Result<Profile, CommandError> {
        let current = self.get(id)?;
        self.prepare_credential_on_update(&current, &mut request)
            .map_err(|error| CommandError::new("VALIDATION", error.to_string()))?;
        self.prepare_proxy_on_update(&current, &mut request)
            .map_err(|error| CommandError::new("INVALID_PROXY_CONFIG", error.to_string()))?;

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
        self.repository.update(&updated)?;
        self.get(id)
    }

    pub(crate) fn delete(&self, id: &str) -> Result<(), CommandError> {
        let references = self.repository.delete(id)?;
        if !references.is_empty() {
            return Err(CommandError::new(
                "PROFILE_IN_USE_AS_JUMP",
                "该连接正被其他服务器用作 SSH 跳板机",
            )
            .with_references(&references));
        }
        Ok(())
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
                .map_err(|error| CommandError::new("ENCRYPT_FAILED", error.to_string()))?;
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
    ) -> Result<(), ProfileError> {
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
                        .map_err(|error| CommandError::new("VALIDATION", error.to_string()))?;
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
                        .map_err(|error| CommandError::new("VALIDATION", error.to_string()))?,
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
                        .map_err(|error| CommandError::new("VALIDATION", error.to_string()))?,
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
    ) -> Result<(), ProfileError> {
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
            other => return Err(format!("unsupported auth_type: {other}").into()),
        }
        Ok(())
    }

    fn resolve_profile_credential(&self, profile: &Profile) -> Result<Credential, ProfileError> {
        if profile.auth_type == AUTH_VAULT && !profile.vault_id.is_empty() {
            return self.retrieve_vault(&profile.vault_id).map_err(|error| {
                ProfileError::Credential(format!("retrieve vault credential: {error}"))
            });
        }
        if !profile.inline_credential.is_empty() {
            return self
                .decode_inline_credential(&profile.inline_credential)
                .map_err(|error| {
                    ProfileError::Credential(format!("decode inline credential: {error}"))
                });
        }
        if !profile.vault_id.is_empty() {
            return self.retrieve_vault(&profile.vault_id).map_err(|error| {
                ProfileError::Credential(format!("retrieve legacy vault credential: {error}"))
            });
        }
        Ok(Credential::default())
    }

    fn vault_metadata(&self, id: &str) -> Result<(String, String), CommandError> {
        self.vault.metadata(id)
    }

    fn retrieve_vault(&self, id: &str) -> Result<Credential, ProfileError> {
        self.vault
            .resolve_for_profile(id)
            .map_err(|error| ProfileError::Credential(error.message))
    }

    fn encode_inline_credential(&self, credential: &Credential) -> Result<String, ProfileError> {
        let raw = serde_json::to_string(credential).map_err(|error| {
            ProfileError::Credential(format!("marshal inline credential: {error}"))
        })?;
        if raw == "{}" {
            return Ok(String::new());
        }
        self.encryptor.encrypt(&raw).map_err(|error| {
            ProfileError::Credential(format!("encrypt inline credential: {error}"))
        })
    }

    fn decode_inline_credential(&self, encoded: &str) -> Result<Credential, ProfileError> {
        if encoded.is_empty() {
            return Ok(Credential::default());
        }
        let decrypted = self.encryptor.decrypt(encoded).map_err(|error| {
            ProfileError::Credential(format!("decrypt inline credential: {error}"))
        })?;
        serde_json::from_str(&decrypted).map_err(|error| {
            ProfileError::Credential(format!("unmarshal inline credential: {error}"))
        })
    }

    fn encode_proxy_password(&self, password: &str) -> Result<String, ProfileError> {
        if password.is_empty() {
            return Ok(String::new());
        }
        self.encryptor
            .encrypt(password)
            .map_err(|error| ProfileError::Credential(format!("加密代理密码: {error}")))
    }

    fn validate_proxy_chain(&self, root_id: &str, root: &ProxyConfig) -> Result<(), ProfileError> {
        let mut visited = HashSet::from([root_id.to_owned()]);
        let mut path = vec![root_id.to_owned()];
        let mut proxy = root.clone();
        let mut depth = 0;
        while proxy.proxy_type == PROXY_JUMP {
            if depth >= MAX_JUMP_PROFILES {
                return Err(ProfileError::Reference(format!(
                    "SSH 跳板链最多允许 {MAX_JUMP_PROFILES} 层"
                )));
            }
            let next_id = proxy.jump_profile_id.clone();
            if visited.contains(&next_id) {
                path.push(next_id);
                return Err(ProfileError::Reference(format!(
                    "SSH 跳板链存在循环引用: {}",
                    path.join(" -> ")
                )));
            }
            let next = self
                .get_optional(&next_id)
                .map_err(|error| ProfileError::Reference(error.message))?
                .ok_or_else(|| {
                    ProfileError::Reference(format!("跳板机 Profile 不存在: {next_id}"))
                })?;
            visited.insert(next_id.clone());
            path.push(next_id);
            proxy = next.proxy;
            depth += 1;
        }
        Ok(())
    }
}

fn apply_vault_username(
    entry_type: &str,
    vault_username: &str,
    requested_username: &str,
) -> Result<String, ProfileError> {
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

fn now() -> String {
    Local::now().to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

fn profile_not_found() -> CommandError {
    CommandError::new("NOT_FOUND", "profile not found")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::connection::PROXY_SOCKS5;
    use rusqlite::params;

    fn state() -> (tempfile::TempDir, ProfileService) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::initialize(directory.path().join("eizhu.db")).unwrap();
        let encryptor = Encryptor::load_or_create(directory.path().join("key")).unwrap();
        let audit = crate::audit::AuditRepository::new(database.clone());
        let vault = VaultService::new(database.clone(), encryptor.clone(), audit);
        let state = ProfileService::initialize(database, encryptor, vault).unwrap();
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
            .repository
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
        let connection = state.repository.database.connect().unwrap();
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
        assert!(error.to_string().contains("最多"), "{error}");
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
            .to_string()
            .contains("不存在"));
    }

    #[test]
    fn legacy_non_vault_credentials_are_backfilled_and_orphans_removed() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::initialize(directory.path().join("eizhu.db")).unwrap();
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
        let audit = crate::audit::AuditRepository::new(database.clone());
        let vault = VaultService::new(database.clone(), encryptor.clone(), audit);
        let state = ProfileService::initialize(database.clone(), encryptor, vault).unwrap();
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
