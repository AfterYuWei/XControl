use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Instant,
};

use russh::Disconnect;
use serde::Serialize;
use tauri::State;

use super::transport::{connect_route, HostKeyVerifier};
use crate::{
    error::CommandError,
    profiles::{ProfileCreateRequest, ProfileState, ProfileUpdateRequest, ResolvedProfileNode},
};

#[derive(Debug, Clone, Serialize)]
pub struct ProfileTestStage {
    stage: String,
    status: String,
    message: String,
    profile_id: String,
    profile_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    latency_ms: Option<i64>,
    #[serde(skip_serializing_if = "String::is_empty")]
    known_fingerprint: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    fingerprint: String,
}

#[derive(Debug, Serialize)]
pub struct ProfileTestResult {
    success: bool,
    message: String,
    latency_ms: i64,
    stages: Vec<ProfileTestStage>,
}

struct TestVerifier {
    stages: Arc<Mutex<Vec<ProfileTestStage>>>,
}

impl HostKeyVerifier for TestVerifier {
    fn verify<'a>(
        &'a self,
        profile_id: &'a str,
        profile_name: &'a str,
        known: &'a str,
        current: &'a str,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            let matches = known.is_empty() || known == current;
            self.stages
                .lock()
                .expect("profile test mutex poisoned")
                .push(ProfileTestStage {
                    stage: "host_key".into(),
                    status: if matches { "success" } else { "error" }.into(),
                    message: if matches {
                        "SSH 主机指纹校验通过"
                    } else {
                        "SSH 主机指纹已变化"
                    }
                    .into(),
                    profile_id: profile_id.into(),
                    profile_name: profile_name.into(),
                    latency_ms: None,
                    known_fingerprint: known.into(),
                    fingerprint: current.into(),
                });
            matches
        })
    }
}

struct ConfirmVerifier {
    target_id: String,
    expected: String,
}

impl HostKeyVerifier for ConfirmVerifier {
    fn verify<'a>(
        &'a self,
        profile_id: &'a str,
        _profile_name: &'a str,
        known: &'a str,
        current: &'a str,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            if profile_id == self.target_id {
                current == self.expected
            } else {
                known.is_empty() || known == current
            }
        })
    }
}

fn stage(node: &ResolvedProfileNode, name: &str, message: impl Into<String>) -> ProfileTestStage {
    ProfileTestStage {
        stage: name.into(),
        status: "success".into(),
        message: message.into(),
        profile_id: node.profile_id.clone(),
        profile_name: node.profile_name.clone(),
        latency_ms: None,
        known_fingerprint: String::new(),
        fingerprint: String::new(),
    }
}

async fn run_test(node: ResolvedProfileNode) -> ProfileTestResult {
    let started = Instant::now();
    let auth_started = Instant::now();
    let mut initial = vec![stage(&node, "resolve", "已解析连接与凭据")];
    if !node.proxy.proxy_type.is_empty() && node.proxy.proxy_type != "direct" {
        let message = if node.proxy.proxy_type == "jump" {
            "将通过 SSH 跳板机连接".to_owned()
        } else {
            format!("{} 代理配置已就绪", node.proxy.proxy_type.to_uppercase())
        };
        initial.push(stage(&node, "proxy", message));
    }
    let stages = Arc::new(Mutex::new(initial));
    let verifier = Arc::new(TestVerifier {
        stages: stages.clone(),
    });
    let result = connect_route(node, verifier).await;
    let success = result.is_ok();
    let detail = match result {
        Ok(route) => {
            let _ = route
                .handle
                .disconnect(
                    Disconnect::ByApplication,
                    "connection test complete",
                    "zh-CN",
                )
                .await;
            "SSH 握手与认证成功".to_owned()
        }
        Err(error) => error,
    };
    stages
        .lock()
        .expect("profile test mutex poisoned")
        .push(ProfileTestStage {
            stage: "ssh_auth".into(),
            status: if success { "success" } else { "error" }.into(),
            message: detail.clone(),
            profile_id: String::new(),
            profile_name: String::new(),
            latency_ms: Some(auth_started.elapsed().as_millis() as i64),
            known_fingerprint: String::new(),
            fingerprint: String::new(),
        });
    let stages = stages.lock().expect("profile test mutex poisoned").clone();
    ProfileTestResult {
        success,
        message: if success {
            "连接测试成功".into()
        } else {
            format!("连接测试失败: {detail}")
        },
        latency_ms: started.elapsed().as_millis() as i64,
        stages,
    }
}

#[tauri::command]
pub async fn profile_test_new(
    state: State<'_, ProfileState>,
    request: ProfileCreateRequest,
) -> Result<ProfileTestResult, CommandError> {
    Ok(run_test(state.resolve_connection_draft_create(request)?).await)
}

#[tauri::command]
pub async fn profile_test_existing(
    state: State<'_, ProfileState>,
    id: String,
    request: ProfileUpdateRequest,
) -> Result<ProfileTestResult, CommandError> {
    Ok(run_test(state.resolve_connection_draft_update(&id, request)?).await)
}

#[tauri::command]
pub async fn profile_confirm_host_key(
    state: State<'_, ProfileState>,
    id: String,
    fingerprint: String,
) -> Result<serde_json::Value, CommandError> {
    if fingerprint.is_empty() {
        return Err(CommandError::new("VALIDATION", "fingerprint is required"));
    }
    let node = state.resolve_connection(&id)?;
    let verifier = Arc::new(ConfirmVerifier {
        target_id: id.clone(),
        expected: fingerprint,
    });
    let route = connect_route(node, verifier).await.map_err(|error| {
        CommandError::new(
            "HOST_KEY_CHANGED_AGAIN",
            format!("服务器主机指纹已再次变化，请重新测试: {error}"),
        )
    })?;
    let current = route
        .host_keys
        .iter()
        .find(|(profile_id, _)| profile_id == &id)
        .map(|(_, current)| current.clone())
        .ok_or_else(|| CommandError::new("HOST_KEY_CHECK_FAILED", "未获取到服务器主机指纹"))?;
    state.persist_host_key(&id, &current)?;
    let _ = route
        .handle
        .disconnect(Disconnect::ByApplication, "host key confirmed", "zh-CN")
        .await;
    Ok(serde_json::json!({"ok":true,"fingerprint":current}))
}
