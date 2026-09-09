use chrono::{Duration, SecondsFormat, Utc};
use reqwest::Client;
use serde::Deserialize;
use url::Url;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::CommandError;

use super::{model::SyncProviderConfig, service::SyncService};

const GDRIVE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GDRIVE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GDRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const ONEDRIVE_AUTH_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const ONEDRIVE_TOKEN_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const ONEDRIVE_SCOPE: &str = "Files.ReadWrite offline_access";
pub const REDIRECT_BASE: &str = "xcontrol://oauth";

pub struct OAuthState {
    pub provider_id: String,
    pub expires_at: chrono::DateTime<Utc>,
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct OAuthToken {
    pub access_token: String,
    pub refresh_token: String,
    pub expiry: String,
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
struct TokenResponse {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    expires_in: i64,
    #[serde(default)]
    error: String,
    #[serde(default)]
    error_description: String,
}

impl SyncService {
    pub fn build_oauth_url(
        &self,
        provider_type: &str,
        provider_id: &str,
    ) -> Result<String, CommandError> {
        let row = self
            .inner
            .repository
            .get_provider(provider_id)
            .map_err(|_| CommandError::new("OAUTH_URL_FAILED", "provider 不存在"))?;
        if row.config.provider_type != provider_type {
            return Err(CommandError::new("OAUTH_URL_FAILED", "provider 类型不匹配"));
        }
        if row.config.oauth_client_id.is_empty() {
            return Err(CommandError::new(
                "OAUTH_URL_FAILED",
                "请先填写 OAuth Client ID",
            ));
        }
        let state = uuid::Uuid::new_v4().to_string();
        self.inner
            .oauth_states
            .lock()
            .map_err(|_| CommandError::new("OAUTH_URL_FAILED", "OAuth 状态锁已损坏"))?
            .insert(
                state.clone(),
                OAuthState {
                    provider_id: provider_id.to_owned(),
                    expires_at: Utc::now() + Duration::minutes(10),
                },
            );
        build_auth_url(provider_type, &row.config, &state)
    }

    pub async fn complete_oauth_url(&self, raw_url: &str) -> Result<String, CommandError> {
        let url = Url::parse(raw_url).map_err(|error| {
            CommandError::new("OAUTH_FAILED", format!("OAuth 回调地址无效: {error}"))
        })?;
        if url.scheme() != "xcontrol" || url.host_str() != Some("oauth") {
            return Err(CommandError::new(
                "OAUTH_FAILED",
                "不是 XControl OAuth 回调",
            ));
        }
        let provider_type = url.path().trim_matches('/');
        if provider_type != "gdrive" && provider_type != "onedrive" {
            return Err(CommandError::new("OAUTH_FAILED", "OAuth provider 类型无效"));
        }
        let code = url
            .query_pairs()
            .find_map(|(key, value)| (key == "code").then(|| value.into_owned()))
            .ok_or_else(|| CommandError::new("OAUTH_FAILED", "缺少 code 参数"))?;
        let state = url
            .query_pairs()
            .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
            .ok_or_else(|| CommandError::new("OAUTH_FAILED", "缺少 state 参数"))?;
        let oauth_state = self
            .inner
            .oauth_states
            .lock()
            .map_err(|_| CommandError::new("OAUTH_FAILED", "OAuth 状态锁已损坏"))?
            .remove(&state)
            .ok_or_else(|| {
                CommandError::new("OAUTH_FAILED", "授权状态无效或已过期，请重新发起授权")
            })?;
        if oauth_state.expires_at < Utc::now() {
            return Err(CommandError::new(
                "OAUTH_FAILED",
                "授权状态无效或已过期，请重新发起授权",
            ));
        }
        let mut row = self
            .inner
            .repository
            .get_provider(&oauth_state.provider_id)
            .map_err(|_| CommandError::new("OAUTH_FAILED", "provider 不存在"))?;
        if row.config.provider_type != provider_type {
            return Err(CommandError::new("OAUTH_FAILED", "provider 类型不匹配"));
        }
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(network_error)?;
        let token = exchange_code(&client, provider_type, &row.config, &code).await?;
        if token.refresh_token.is_empty() {
            return Err(CommandError::new(
                "OAUTH_FAILED",
                "未获得 refresh_token（Google 授权需允许离线访问，请重试）",
            ));
        }
        row.config.oauth_access_token = token.access_token.clone();
        row.config.oauth_refresh_token = token.refresh_token.clone();
        row.config.oauth_expiry = token.expiry.clone();
        self.inner
            .repository
            .save_provider_config(&oauth_state.provider_id, &row.config)?;
        self.inner
            .repository
            .log_event(&oauth_state.provider_id, "oauth", 0, true, "authorized");
        Ok(oauth_state.provider_id)
    }
}

fn build_auth_url(
    provider_type: &str,
    config: &SyncProviderConfig,
    state: &str,
) -> Result<String, CommandError> {
    let (endpoint, scope) = match provider_type {
        "gdrive" => (GDRIVE_AUTH_URL, GDRIVE_SCOPE),
        "onedrive" => (ONEDRIVE_AUTH_URL, ONEDRIVE_SCOPE),
        _ => {
            return Err(CommandError::new(
                "OAUTH_URL_FAILED",
                format!("unsupported oauth provider type: {provider_type}"),
            ))
        }
    };
    let mut url = Url::parse(endpoint).expect("constant OAuth URL");
    url.query_pairs_mut()
        .append_pair("client_id", &config.oauth_client_id)
        .append_pair("redirect_uri", &redirect_uri(provider_type))
        .append_pair("response_type", "code")
        .append_pair("state", state)
        .append_pair("scope", scope);
    if provider_type == "gdrive" {
        url.query_pairs_mut()
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent");
    }
    Ok(url.into())
}

async fn exchange_code(
    client: &Client,
    provider_type: &str,
    config: &SyncProviderConfig,
    code: &str,
) -> Result<OAuthToken, CommandError> {
    token_request(
        client,
        token_endpoint(provider_type)?,
        &[
            ("client_id", config.oauth_client_id.as_str()),
            ("client_secret", config.oauth_client_secret.as_str()),
            ("code", code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", &redirect_uri(provider_type)),
        ],
        "",
    )
    .await
}

pub async fn refresh_tokens(
    client: &Client,
    config: &SyncProviderConfig,
) -> Result<OAuthToken, CommandError> {
    token_request(
        client,
        token_endpoint(&config.provider_type)?,
        &[
            ("client_id", config.oauth_client_id.as_str()),
            ("client_secret", config.oauth_client_secret.as_str()),
            ("refresh_token", config.oauth_refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ],
        &config.oauth_refresh_token,
    )
    .await
}

async fn token_request(
    client: &Client,
    endpoint: &str,
    form: &[(&str, &str)],
    old_refresh_token: &str,
) -> Result<OAuthToken, CommandError> {
    let response = client
        .post(endpoint)
        .form(form)
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status();
    let mut body: TokenResponse = response.json().await.map_err(network_error)?;
    if !body.error.is_empty() {
        return Err(CommandError::new(
            "OAUTH_FAILED",
            format!("oauth 错误: {} ({})", body.error, body.error_description),
        ));
    }
    if body.access_token.is_empty() {
        return Err(CommandError::new(
            "OAUTH_FAILED",
            format!("oauth 响应缺少 access_token (HTTP {status})"),
        ));
    }
    if body.refresh_token.is_empty() {
        body.refresh_token = old_refresh_token.to_owned();
    }
    let seconds = if body.expires_in == 0 {
        3600
    } else {
        body.expires_in
    };
    Ok(OAuthToken {
        access_token: body.access_token.clone(),
        refresh_token: body.refresh_token.clone(),
        expiry: (Utc::now() + Duration::seconds(seconds))
            .to_rfc3339_opts(SecondsFormat::AutoSi, true),
    })
}

fn token_endpoint(provider_type: &str) -> Result<&'static str, CommandError> {
    match provider_type {
        "gdrive" => Ok(GDRIVE_TOKEN_URL),
        "onedrive" => Ok(ONEDRIVE_TOKEN_URL),
        _ => Err(CommandError::new(
            "OAUTH_FAILED",
            format!("unsupported oauth provider type: {provider_type}"),
        )),
    }
}

fn redirect_uri(provider_type: &str) -> String {
    format!("{REDIRECT_BASE}/{provider_type}")
}

fn network_error(error: reqwest::Error) -> CommandError {
    CommandError::new("OAUTH_FAILED", format!("token 请求失败: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_url_uses_native_deep_link_and_offline_access() {
        let mut config = SyncProviderConfig::default();
        config.provider_type = "gdrive".into();
        config.name = "Drive".into();
        config.enabled = true;
        config.oauth_client_id = "client id".into();
        let url = build_auth_url("gdrive", &config, "state-abc").unwrap();
        let url = Url::parse(&url).unwrap();
        let query = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(query["redirect_uri"], "xcontrol://oauth/gdrive");
        assert_eq!(query["state"], "state-abc");
        assert_eq!(query["access_type"], "offline");
    }
}
