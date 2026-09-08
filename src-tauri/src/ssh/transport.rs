use std::{
    future::Future,
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use russh::{
    client,
    keys::{self, ssh_key::HashAlg},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};

use crate::profiles::{ProxyConfig, ResolvedProfileNode};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) trait AsyncStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncStream for T {}
type BoxStream = Box<dyn AsyncStream>;

pub(crate) trait HostKeyVerifier: Send + Sync {
    fn verify<'a>(
        &'a self,
        profile_id: &'a str,
        profile_name: &'a str,
        known: &'a str,
        current: &'a str,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;
}

pub(crate) struct ClientHandler {
    profile_id: String,
    profile_name: String,
    known: String,
    current: Arc<Mutex<Option<String>>>,
    verifier: Arc<dyn HostKeyVerifier>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        *self.current.lock().expect("host key mutex poisoned") = Some(fingerprint.clone());
        Ok(self
            .verifier
            .verify(
                &self.profile_id,
                &self.profile_name,
                &self.known,
                &fingerprint,
            )
            .await)
    }
}

pub(crate) struct ConnectedRoute {
    pub handle: client::Handle<ClientHandler>,
    pub host_keys: Vec<(String, String)>,
    _jump_handles: Vec<client::Handle<ClientHandler>>,
}

pub(crate) async fn connect_route(
    root: ResolvedProfileNode,
    verifier: Arc<dyn HostKeyVerifier>,
) -> Result<ConnectedRoute, String> {
    connect_node(root, verifier).await
}

fn connect_node(
    mut node: ResolvedProfileNode,
    verifier: Arc<dyn HostKeyVerifier>,
) -> Pin<Box<dyn Future<Output = Result<ConnectedRoute, String>> + Send>> {
    Box::pin(async move {
        let (stream, jump_handles, mut host_keys) = if let Some(jump) = node.jump.take() {
            let mut route = connect_node(*jump, verifier.clone()).await?;
            let channel = timeout(
                CONNECT_TIMEOUT,
                route.handle.channel_open_direct_tcpip(
                    node.host.clone(),
                    u32::from(node.port),
                    "127.0.0.1",
                    0,
                ),
            )
            .await
            .map_err(|_| "通过 SSH 跳板机建立通道超时".to_owned())?
            .map_err(|error| format!("通过 SSH 跳板机建立通道: {error}"))?;
            route._jump_handles.push(route.handle);
            (
                Box::new(channel.into_stream()) as BoxStream,
                route._jump_handles,
                route.host_keys,
            )
        } else {
            (
                dial_transport(&node.host, node.port, &node.proxy, &node.proxy_password).await?,
                Vec::new(),
                Vec::new(),
            )
        };

        let current = Arc::new(Mutex::new(None));
        let handler = ClientHandler {
            profile_id: node.profile_id.clone(),
            profile_name: node.profile_name.clone(),
            known: node.known_host_key.clone(),
            current: current.clone(),
            verifier,
        };
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(120)),
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });
        let mut handle = timeout(
            CONNECT_TIMEOUT,
            client::connect_stream(config, stream, handler),
        )
        .await
        .map_err(|_| format!("连接 {} 超时", node.profile_name))?
        .map_err(|error| format!("SSH 握手失败: {error}"))?;

        authenticate(&mut handle, &node).await?;
        let fingerprint = current
            .lock()
            .expect("host key mutex poisoned")
            .clone()
            .ok_or_else(|| "SSH 服务端未提供主机密钥".to_owned())?;
        host_keys.push((node.profile_id.clone(), fingerprint));

        Ok(ConnectedRoute {
            handle,
            host_keys,
            _jump_handles: jump_handles,
        })
    })
}

async fn authenticate(
    handle: &mut client::Handle<ClientHandler>,
    node: &ResolvedProfileNode,
) -> Result<(), String> {
    let result = match node.auth_type.as_str() {
        "password" | "vault" if !node.password.is_empty() => handle
            .authenticate_password(node.username.clone(), node.password.clone())
            .await
            .map_err(|error| format!("密码认证失败: {error}"))?,
        "key" | "vault" if !node.private_key.is_empty() => {
            let key = keys::decode_secret_key(
                &node.private_key,
                (!node.passphrase.is_empty()).then_some(node.passphrase.as_str()),
            )
            .map_err(|error| format!("解析 SSH 私钥: {error}"))?;
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|error| format!("协商 RSA 签名算法: {error}"))?
                .flatten();
            handle
                .authenticate_publickey(
                    node.username.clone(),
                    keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|error| format!("私钥认证失败: {error}"))?
        }
        "agent" => return authenticate_agent(handle, &node.username).await,
        other => return Err(format!("不支持的 SSH 认证类型: {other}")),
    };
    if result.success() {
        Ok(())
    } else {
        Err("SSH 认证失败，请检查用户名和凭据".into())
    }
}

#[cfg(unix)]
async fn authenticate_agent(
    handle: &mut client::Handle<ClientHandler>,
    username: &str,
) -> Result<(), String> {
    let mut agent = keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|error| format!("连接 SSH Agent: {error}"))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|error| format!("读取 SSH Agent 密钥: {error}"))?;
    for identity in identities {
        let public = identity.public_key().into_owned();
        let hash = handle
            .best_supported_rsa_hash()
            .await
            .map_err(|error| format!("协商 RSA 签名算法: {error}"))?
            .flatten();
        let result = handle
            .authenticate_publickey_with(username, public, hash, &mut agent)
            .await
            .map_err(|error| format!("SSH Agent 签名失败: {error}"))?;
        if result.success() {
            return Ok(());
        }
    }
    Err("SSH Agent 中没有可用的认证密钥".into())
}

#[cfg(not(unix))]
async fn authenticate_agent(
    _handle: &mut client::Handle<ClientHandler>,
    _username: &str,
) -> Result<(), String> {
    Err("当前平台暂不支持 SSH Agent 认证".into())
}

async fn dial_transport(
    host: &str,
    port: u16,
    proxy: &ProxyConfig,
    proxy_password: &str,
) -> Result<BoxStream, String> {
    if proxy.proxy_type.is_empty() || proxy.proxy_type == "direct" {
        return Ok(Box::new(connect_tcp(host, port).await?));
    }
    let proxy_port = u16::try_from(proxy.port).map_err(|_| "代理端口无效".to_owned())?;
    let mut stream = connect_tcp(&proxy.host, proxy_port)
        .await
        .map_err(|error| format!("连接代理 {}:{}: {error}", proxy.host, proxy.port))?;
    match proxy.proxy_type.as_str() {
        "socks5" => {
            establish_socks5(&mut stream, host, port, &proxy.username, proxy_password).await?;
        }
        "http" => {
            establish_http_connect(&mut stream, host, port, &proxy.username, proxy_password)
                .await?;
        }
        other => return Err(format!("不支持的代理类型: {other}")),
    }
    Ok(Box::new(stream))
}

async fn connect_tcp(host: &str, port: u16) -> Result<TcpStream, String> {
    timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| format!("连接 {host}:{port} 超时"))?
        .map_err(|error| format!("连接 {host}:{port}: {error}"))
}

async fn establish_socks5(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    username: &str,
    password: &str,
) -> Result<(), String> {
    let methods: &[u8] = if username.is_empty() { &[0] } else { &[0, 2] };
    stream
        .write_all(&[&[5, methods.len() as u8], methods].concat())
        .await
        .map_err(proxy_io("SOCKS5 协商失败"))?;
    let mut response = [0_u8; 2];
    stream
        .read_exact(&mut response)
        .await
        .map_err(proxy_io("读取 SOCKS5 协商响应"))?;
    if response[0] != 5 || response[1] == 0xff {
        return Err("SOCKS5 代理不接受可用的认证方式".into());
    }
    if response[1] == 2 {
        if username.is_empty() || username.len() > 255 || password.len() > 255 {
            return Err("SOCKS5 代理认证参数无效".into());
        }
        let mut auth = vec![1, username.len() as u8];
        auth.extend_from_slice(username.as_bytes());
        auth.push(password.len() as u8);
        auth.extend_from_slice(password.as_bytes());
        stream
            .write_all(&auth)
            .await
            .map_err(proxy_io("SOCKS5 认证失败"))?;
        stream
            .read_exact(&mut response)
            .await
            .map_err(proxy_io("读取 SOCKS5 认证响应"))?;
        if response[1] != 0 {
            return Err("SOCKS5 用户名或密码错误".into());
        }
    } else if response[1] != 0 {
        return Err(format!("SOCKS5 代理返回未知认证方式: {}", response[1]));
    }

    if host.len() > 255 {
        return Err("SOCKS5 目标域名长度无效".into());
    }
    let mut request = vec![5, 1, 0, 3, host.len() as u8];
    request.extend_from_slice(host.as_bytes());
    request.extend_from_slice(&port.to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(proxy_io("发送 SOCKS5 CONNECT"))?;
    let mut header = [0_u8; 4];
    stream
        .read_exact(&mut header)
        .await
        .map_err(proxy_io("读取 SOCKS5 CONNECT 响应"))?;
    if header[0] != 5 || header[1] != 0 {
        return Err(format!("SOCKS5 CONNECT 被拒绝，状态码 {}", header[1]));
    }
    let address_len = match header[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut length = [0_u8; 1];
            stream
                .read_exact(&mut length)
                .await
                .map_err(proxy_io("读取 SOCKS5 响应地址"))?;
            usize::from(length[0])
        }
        _ => return Err("SOCKS5 响应地址类型无效".into()),
    };
    let mut ignored = vec![0_u8; address_len + 2];
    stream
        .read_exact(&mut ignored)
        .await
        .map_err(proxy_io("读取 SOCKS5 响应地址"))?;
    Ok(())
}

async fn establish_http_connect(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    username: &str,
    password: &str,
) -> Result<(), String> {
    let authority = format!("{host}:{port}");
    let auth = if username.is_empty() {
        String::new()
    } else {
        format!(
            "Proxy-Authorization: Basic {}\r\n",
            STANDARD.encode(format!("{username}:{password}"))
        )
    };
    let request = format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n{auth}Proxy-Connection: Keep-Alive\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(proxy_io("发送 HTTP CONNECT"))?;
    let mut response = Vec::with_capacity(512);
    while response.len() < 32 * 1024 && !response.ends_with(b"\r\n\r\n") {
        let mut byte = [0_u8; 1];
        stream
            .read_exact(&mut byte)
            .await
            .map_err(proxy_io("读取 HTTP CONNECT 响应"))?;
        response.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&response);
    let status = head.lines().next().unwrap_or_default();
    let accepted = status
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .is_some_and(|code| (200..300).contains(&code));
    if !accepted {
        return Err(format!("HTTP CONNECT 被拒绝: {status}"));
    }
    Ok(())
}

fn proxy_io(context: &'static str) -> impl FnOnce(io::Error) -> String {
    move |error| format!("{context}: {error}")
}
