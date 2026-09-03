//! 极简 loopback HTTP/1.1 客户端。
//!
//! 仅用于访问本机 xcontrol-server（明文 HTTP），避免引入 reqwest/ureq 等重依赖。
//! 通过 `Connection: close` 请求头让服务端发完响应即关闭连接，读响应到 EOF，
//! 从而无需实现 keep-alive 与 Content-Length 语义（方案 §5.1）。

use std::{
    io::{self, Read, Write},
    net::TcpStream,
    time::Duration,
};

pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// 响应体（P2 下载保存 / P3 sftp_drag_out 轮询会读取；当前仅测试使用）
    #[allow(dead_code)]
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// 大小写不敏感获取响应头。
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// 发起一次 HTTP 请求。
///
/// - `bearer`：附加 `Authorization: Bearer <token>`
/// - `origin`：附加 `Origin` 头（用于触发/校验后端 CORS 行为）
/// - `body`：JSON 请求体，自动附加 Content-Type / Content-Length
pub fn request(
    port: u16,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    origin: Option<&str>,
    body: Option<&[u8]>,
) -> io::Result<HttpResponse> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;

    let mut head =
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    if let Some(token) = bearer {
        head.push_str("Authorization: Bearer ");
        head.push_str(token);
        head.push_str("\r\n");
    }
    if let Some(origin) = origin {
        head.push_str("Origin: ");
        head.push_str(origin);
        head.push_str("\r\n");
    }
    if let Some(bytes) = body {
        head.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            bytes.len()
        ));
    }
    head.push_str("\r\n");

    stream.write_all(head.as_bytes())?;
    if let Some(bytes) = body {
        stream.write_all(bytes)?;
    }
    stream.flush()?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    parse_response(&raw)
}

fn parse_response(raw: &[u8]) -> io::Result<HttpResponse> {
    let split = find(raw, b"\r\n\r\n").ok_or_else(|| other("响应缺少头部结束符"))?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut body = raw[split + 4..].to_vec();

    let mut lines = head.lines();
    let status_line = lines.next().ok_or_else(|| other("空响应"))?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| other("状态行解析失败"))?;

    let mut headers = Vec::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.push((key.trim().to_string(), value.trim().to_string()));
        }
    }

    let chunked = headers.iter().any(|(key, value)| {
        key.eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
    });
    if chunked {
        body = decode_chunked(&body)?;
    }

    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

/// 解码 chunked 传输编码（Go 服务端部分响应使用）。
fn decode_chunked(data: &[u8]) -> io::Result<Vec<u8>> {
    let mut rest = data;
    let mut out = Vec::new();
    loop {
        let newline = find(rest, b"\r\n").ok_or_else(|| other("chunk 长度行缺失"))?;
        let size_line =
            std::str::from_utf8(&rest[..newline]).map_err(|_| other("chunk 长度非 UTF-8"))?;
        let size_text = size_line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| other("chunk 长度非法"))?;
        rest = &rest[newline + 2..];
        if size == 0 {
            break;
        }
        if rest.len() < size {
            return Err(other("chunk 数据不完整"));
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[size..];
        if rest.starts_with(b"\r\n") {
            rest = &rest[2..];
        }
    }
    Ok(out)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn other(message: &str) -> io::Error {
    io::Error::other(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn parses_simple_response() {
        let raw = b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
        let response = parse_response(raw).unwrap();
        assert_eq!(response.status, 204);
        assert_eq!(response.header("content-length"), Some("0"));
        assert!(response.body.is_empty());
    }

    #[test]
    fn decodes_chunked_body() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
        let response = parse_response(raw).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"Wikipedia");
    }

    #[test]
    fn requests_over_loopback() {
        // 起一个只回固定响应的本地服务，验证完整请求-响应往返
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            if let Ok((mut conn, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = conn.read(&mut buf);
                let payload =
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";
                let _ = conn.write_all(payload);
            }
        });

        let response = request(port, "GET", "/x", Some("token"), None, None).unwrap();
        server.join().unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"ok");
        assert_eq!(response.header("connection"), Some("close"));
    }
}
