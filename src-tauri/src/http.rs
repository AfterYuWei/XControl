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

/// 发起一次 HTTP 请求（请求体默认按 `application/json` 发送）。
///
/// - `bearer`：附加 `Authorization: Bearer <token>`
/// - `origin`：附加 `Origin` 头（用于触发/校验后端 CORS 行为）
/// - `body`：请求体，自动附加 Content-Type / Content-Length
pub fn request(
    port: u16,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    origin: Option<&str>,
    body: Option<&[u8]>,
) -> io::Result<HttpResponse> {
    request_ct(port, method, path, bearer, origin, body, "application/json")
}

/// 同 [`request`]，但允许为请求体指定 Content-Type（multipart 上传等场景）。
pub fn request_ct(
    port: u16,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    origin: Option<&str>,
    body: Option<&[u8]>,
    content_type: &str,
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
            "Content-Type: {content_type}\r\nContent-Length: {}\r\n",
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

/// 构造好的 multipart/form-data 请求体（RFC 7578）。
pub struct MultipartForm {
    pub body: Vec<u8>,
    /// 请求头 Content-Type（含 boundary 参数）
    pub content_type: String,
}

/// 构造 multipart/form-data：首个 part 为文件，随后为文本字段。
/// 用于 Rust 侧直传（WebView2 虚拟源下 File/blob 经 fetch FormData 发送
/// 会以 "Failed to fetch" 失败，见 commands.rs 的 upload_file_form）。
pub fn build_multipart(
    file_field: &str,
    filename: &str,
    file_bytes: &[u8],
    fields: &[(String, String)],
) -> MultipartForm {
    let mut random = [0u8; 16];
    let _ = getrandom::fill(&mut random);
    let hex = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let boundary = format!("xcontrol-{hex}");

    // 防御性过滤：避免文件名中的引号/换行破坏 Content-Disposition 结构
    let safe_filename: String = filename
        .chars()
        .filter(|c| !matches!(c, '"' | '\\' | '\r' | '\n'))
        .collect();

    let mut body = Vec::with_capacity(file_bytes.len() + 512);
    body.extend_from_slice(
        format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"{file_field}\"; filename=\"{safe_filename}\"\r\n\
             Content-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(file_bytes);
    body.extend_from_slice(b"\r\n");
    for (name, value) in fields {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\n\
                 Content-Disposition: form-data; name=\"{name}\"\r\n\r\n\
                 {value}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    MultipartForm {
        body,
        content_type: format!("multipart/form-data; boundary={boundary}"),
    }
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

    #[test]
    fn multipart_structure_matches_rfc7578() {
        let form = build_multipart(
            "file",
            "demo.xcbackup",
            b"FILE_DATA",
            &[("strategy".into(), "skip".into())],
        );
        assert!(form
            .content_type
            .starts_with("multipart/form-data; boundary=xcontrol-"));
        let boundary = form.content_type.rsplit('=').next().unwrap();
        let text = String::from_utf8(form.body).unwrap();
        assert_eq!(
            text,
            format!(
                "--{boundary}\r\n\
                 Content-Disposition: form-data; name=\"file\"; filename=\"demo.xcbackup\"\r\n\
                 Content-Type: application/octet-stream\r\n\r\n\
                 FILE_DATA\r\n\
                 --{boundary}\r\n\
                 Content-Disposition: form-data; name=\"strategy\"\r\n\r\n\
                 skip\r\n\
                 --{boundary}--\r\n"
            )
        );
    }

    #[test]
    fn multipart_sanitizes_unsafe_filename() {
        let form = build_multipart("file", "a\"b\\c\r\nd.xcbackup", b"x", &[]);
        let text = String::from_utf8(form.body).unwrap();
        assert!(text.contains("filename=\"abcd.xcbackup\""));
        // 无字段时也必须有终止 boundary
        let boundary = form.content_type.rsplit('=').next().unwrap();
        assert!(text.ends_with(&format!("--{boundary}--\r\n")));
    }

    #[test]
    fn request_ct_sends_custom_content_type() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let Ok((mut conn, _)) = listener.accept() else {
                return String::new();
            };
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            // 先读到头部结束，再按 Content-Length 读满请求体（单次 read 会截断）
            let head_end = loop {
                let n = conn.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    return String::new();
                }
                raw.extend_from_slice(&buf[..n]);
                if let Some(i) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
            let content_length: usize = head
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    if key.eq_ignore_ascii_case("content-length") {
                        value.trim().parse().ok()
                    } else {
                        None
                    }
                })
                .unwrap_or(0);
            while raw.len() < head_end + content_length {
                let n = conn.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&buf[..n]);
            }
            let _ = conn
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
            String::from_utf8_lossy(&raw).to_string()
        });

        let form = build_multipart("file", "u.xcbackup", b"PAYLOAD", &[]);
        let response = request_ct(
            port,
            "POST",
            "/api/backup/preview",
            Some("tk"),
            None,
            Some(&form.body),
            &form.content_type,
        )
        .unwrap();
        let raw = server.join().unwrap();

        assert_eq!(response.status, 200);
        assert!(raw.starts_with("POST /api/backup/preview HTTP/1.1\r\n"));
        assert!(raw.contains("Authorization: Bearer tk\r\n"));
        assert!(raw.contains(&format!("Content-Type: {}\r\n", form.content_type)));
        assert!(raw.contains(&format!("Content-Length: {}\r\n", form.body.len())));
        // 请求体完整落在头部之后
        let body_offset = raw.find("\r\n\r\n").map(|i| i + 4).unwrap_or(0);
        assert_eq!(&raw[body_offset..], String::from_utf8_lossy(&form.body));
    }
}
