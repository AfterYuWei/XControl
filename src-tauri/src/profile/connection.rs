use serde_json::{Map, Value};

use crate::error::CommandError;

use super::{ProxyConfig, ProxyInput};

pub(super) const PROXY_DIRECT: &str = "direct";
pub(super) const PROXY_SOCKS5: &str = "socks5";
pub(super) const PROXY_HTTP: &str = "http";
pub(super) const PROXY_JUMP: &str = "jump";

pub(super) fn profile_host_key_fingerprint(raw: &str) -> String {
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

pub(super) fn with_profile_host_key_fingerprint(
    raw: &str,
    fingerprint: &str,
) -> Result<String, CommandError> {
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

pub(super) fn normalize_proxy_input(input: Option<&ProxyInput>) -> Result<ProxyConfig, String> {
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

pub(super) fn parse_proxy_options(raw: &str) -> ProxyConfig {
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

pub(super) fn with_proxy_options(
    raw: &str,
    proxy: &ProxyConfig,
) -> Result<String, serde_json::Error> {
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

pub(super) fn same_proxy_identity(left: &ProxyConfig, right: &ProxyConfig) -> bool {
    left.proxy_type == right.proxy_type
        && left.host == right.host
        && left.port == right.port
        && left.username == right.username
        && left.jump_profile_id == right.jump_profile_id
}
