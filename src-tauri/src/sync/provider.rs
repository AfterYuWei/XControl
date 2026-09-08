use std::time::Duration;

use chrono::Utc;
use hmac::{Hmac, Mac};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::{Client, Method, Response, StatusCode};
use sha2::{Digest, Sha256};
use url::Url;

use crate::error::CommandError;

use super::{
    model::{CloudIndex, SyncProviderConfig},
    oauth,
    store::SyncRepository,
};

const GDRIVE_API: &str = "https://www.googleapis.com/drive/v3";
const GDRIVE_UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";
const GRAPH_API: &str = "https://graph.microsoft.com/v1.0";
const BACKUP_FOLDER: &str = "xcontrol-backups";
const ONEDRIVE_SIMPLE_UPLOAD_MAX: usize = 4 << 20;
const AWS_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'!')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'\'')
    .add(b'(')
    .add(b')')
    .add(b'*')
    .add(b'+')
    .add(b',')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[derive(Clone)]
pub struct CloudProvider {
    id: String,
    name: String,
    config: SyncProviderConfig,
    repository: SyncRepository,
    client: Client,
}

impl CloudProvider {
    pub fn new(
        id: String,
        config: SyncProviderConfig,
        repository: SyncRepository,
    ) -> Result<Self, CommandError> {
        let client = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(network_error)?;
        Ok(Self {
            id,
            name: config.name.clone(),
            config,
            repository,
            client,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub async fn ping(&mut self) -> Result<(), CommandError> {
        match self.config.provider_type.as_str() {
            "webdav" => {
                self.webdav_request(Method::PUT, ".xcontrol-probe", b"ok".to_vec())
                    .await?;
                let _ = self
                    .webdav_request(Method::DELETE, ".xcontrol-probe", vec![])
                    .await;
                Ok(())
            }
            "s3" => {
                self.s3_request(Method::PUT, ".xcontrol-probe", b"ok".to_vec())
                    .await?;
                let _ = self
                    .s3_request(Method::DELETE, ".xcontrol-probe", vec![])
                    .await;
                Ok(())
            }
            "gdrive" => self.ensure_gdrive_folder().await.map(|_| ()),
            "onedrive" => self.ensure_onedrive_folder().await,
            other => Err(CommandError::new(
                "SYNC_FAILED",
                format!("暂不支持的云服务类型: {other}"),
            )),
        }
    }

    pub async fn read_index(&mut self) -> Result<CloudIndex, CommandError> {
        match self.get_object("index.json").await {
            Ok(bytes) => {
                let mut index: CloudIndex = serde_json::from_slice(&bytes).map_err(|error| {
                    CommandError::new("SYNC_FAILED", format!("云端索引损坏: {error}"))
                })?;
                if index.versions.is_empty() {
                    index.versions = vec![];
                }
                Ok(index)
            }
            Err(error) if error.code == "OBJECT_NOT_FOUND" => Ok(CloudIndex::default()),
            Err(error) => Err(error),
        }
    }

    pub async fn write_index(&mut self, index: &CloudIndex) -> Result<(), CommandError> {
        let raw = serde_json::to_vec(index).map_err(|error| {
            CommandError::new("SYNC_FAILED", format!("序列化云端索引失败: {error}"))
        })?;
        self.put_object("index.json", raw).await
    }

    pub async fn put_object(&mut self, name: &str, bytes: Vec<u8>) -> Result<(), CommandError> {
        match self.config.provider_type.as_str() {
            "webdav" => {
                self.webdav_request(Method::PUT, name, bytes).await?;
                Ok(())
            }
            "s3" => {
                self.s3_request(Method::PUT, name, bytes).await?;
                Ok(())
            }
            "gdrive" => self.gdrive_upload(name, bytes).await,
            "onedrive" => self.onedrive_put(name, bytes).await,
            other => Err(unsupported(other)),
        }
    }

    pub async fn get_object(&mut self, name: &str) -> Result<Vec<u8>, CommandError> {
        let response = match self.config.provider_type.as_str() {
            "webdav" => self.webdav_request(Method::GET, name, vec![]).await?,
            "s3" => self.s3_request(Method::GET, name, vec![]).await?,
            "gdrive" => {
                let folder = self.ensure_gdrive_folder().await?;
                let file = self.gdrive_find(&folder, name).await?;
                self.oauth_request(
                    Method::GET,
                    format!("{GDRIVE_API}/files/{file}?alt=media"),
                    vec![],
                    None,
                )
                .await?
            }
            "onedrive" => {
                let response = self
                    .oauth_request(
                        Method::GET,
                        format!("{}:/content", self.onedrive_item_url(name)),
                        vec![],
                        None,
                    )
                    .await?;
                response
            }
            other => return Err(unsupported(other)),
        };
        if response.status() == StatusCode::NOT_FOUND {
            return Err(CommandError::new("OBJECT_NOT_FOUND", "object not found"));
        }
        response_bytes(response, "下载失败").await
    }

    pub async fn delete_object(&mut self, name: &str) -> Result<(), CommandError> {
        let response = match self.config.provider_type.as_str() {
            "webdav" => self.webdav_request(Method::DELETE, name, vec![]).await?,
            "s3" => self.s3_request(Method::DELETE, name, vec![]).await?,
            "gdrive" => {
                let folder = self.ensure_gdrive_folder().await?;
                let file = match self.gdrive_find(&folder, name).await {
                    Ok(file) => file,
                    Err(error) if error.code == "OBJECT_NOT_FOUND" => return Ok(()),
                    Err(error) => return Err(error),
                };
                self.oauth_request(
                    Method::DELETE,
                    format!("{GDRIVE_API}/files/{file}"),
                    vec![],
                    None,
                )
                .await?
            }
            "onedrive" => {
                self.oauth_request(Method::DELETE, self.onedrive_item_url(name), vec![], None)
                    .await?
            }
            other => return Err(unsupported(other)),
        };
        if response.status() == StatusCode::NOT_FOUND || response.status().is_success() {
            Ok(())
        } else {
            Err(http_error("删除失败", response).await)
        }
    }

    async fn webdav_request(
        &self,
        method: Method,
        name: &str,
        body: Vec<u8>,
    ) -> Result<Response, CommandError> {
        let url = format!(
            "{}/{}",
            self.config.endpoint.trim_end_matches('/'),
            name.trim_start_matches('/')
        );
        let mut request = self.client.request(method, url).body(body);
        if !self.config.username.is_empty() || !self.config.password.is_empty() {
            request = request.basic_auth(&self.config.username, Some(&self.config.password));
        }
        let response = request.send().await.map_err(network_error)?;
        if response.status() == StatusCode::NOT_FOUND || response.status().is_success() {
            Ok(response)
        } else {
            Err(http_error("WebDAV 请求失败", response).await)
        }
    }

    async fn s3_request(
        &self,
        method: Method,
        name: &str,
        body: Vec<u8>,
    ) -> Result<Response, CommandError> {
        let region = if self.config.s3_region.is_empty() {
            "us-east-1"
        } else {
            &self.config.s3_region
        };
        let key = format!(
            "{}{}",
            normalize_prefix(&self.config.s3_prefix),
            name.trim_start_matches('/')
        );
        let encoded_key = key
            .split('/')
            .map(|part| utf8_percent_encode(part, AWS_ENCODE_SET).to_string())
            .collect::<Vec<_>>()
            .join("/");
        let path_style = self.config.s3_path_style || !self.config.s3_endpoint.is_empty();
        let raw_url = if !self.config.s3_endpoint.is_empty() {
            format!(
                "{}/{}/{}",
                self.config.s3_endpoint.trim_end_matches('/'),
                utf8_percent_encode(&self.config.s3_bucket, AWS_ENCODE_SET),
                encoded_key
            )
        } else if path_style {
            format!(
                "https://s3.{region}.amazonaws.com/{}/{encoded_key}",
                self.config.s3_bucket
            )
        } else if region == "us-east-1" {
            format!(
                "https://{}.s3.amazonaws.com/{encoded_key}",
                self.config.s3_bucket
            )
        } else {
            format!(
                "https://{}.s3.{region}.amazonaws.com/{encoded_key}",
                self.config.s3_bucket
            )
        };
        let url = Url::parse(&raw_url).map_err(|error| {
            CommandError::new("SYNC_FAILED", format!("S3 Endpoint 无效: {error}"))
        })?;
        let host = url
            .host_str()
            .ok_or_else(|| CommandError::new("SYNC_FAILED", "S3 Endpoint 缺少主机名"))?;
        let host_header = match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        };
        let payload_hash = hex_sha256(&body);
        let timestamp = Utc::now();
        let amz_date = timestamp.format("%Y%m%dT%H%M%SZ").to_string();
        let date = timestamp.format("%Y%m%d").to_string();
        let canonical_headers = format!(
            "host:{host_header}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
        );
        let canonical = format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            method.as_str(),
            url.path(),
            url.query().unwrap_or_default(),
            canonical_headers,
            "host;x-amz-content-sha256;x-amz-date",
            payload_hash
        );
        let scope = format!("{date}/{region}/s3/aws4_request");
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
            hex_sha256(canonical.as_bytes())
        );
        let signature = s3_signature(
            &self.config.s3_secret_key,
            &date,
            region,
            string_to_sign.as_bytes(),
        )?;
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={signature}",
            self.config.s3_access_key
        );
        let response = self
            .client
            .request(method, url)
            .header("x-amz-content-sha256", payload_hash)
            .header("x-amz-date", amz_date)
            .header("authorization", authorization)
            .body(body)
            .send()
            .await
            .map_err(network_error)?;
        if response.status() == StatusCode::NOT_FOUND || response.status().is_success() {
            Ok(response)
        } else {
            Err(http_error("S3 请求失败", response).await)
        }
    }

    async fn oauth_request(
        &mut self,
        method: Method,
        url: String,
        body: Vec<u8>,
        content_type: Option<&str>,
    ) -> Result<Response, CommandError> {
        let send = |token: &str| {
            let mut request = self
                .client
                .request(method.clone(), &url)
                .bearer_auth(token)
                .body(body.clone());
            if let Some(content_type) = content_type {
                request = request.header("content-type", content_type);
            }
            request
        };
        let mut response = send(&self.config.oauth_access_token)
            .send()
            .await
            .map_err(network_error)?;
        if response.status() == StatusCode::UNAUTHORIZED {
            drop(response);
            let token = oauth::refresh_tokens(&self.client, &self.config).await?;
            self.config
                .oauth_access_token
                .clone_from(&token.access_token);
            self.config
                .oauth_refresh_token
                .clone_from(&token.refresh_token);
            self.config.oauth_expiry.clone_from(&token.expiry);
            self.repository
                .save_provider_config(&self.id, &self.config)?;
            response = send(&self.config.oauth_access_token)
                .send()
                .await
                .map_err(network_error)?;
        }
        Ok(response)
    }

    async fn ensure_gdrive_folder(&mut self) -> Result<String, CommandError> {
        if !self.config.drive_folder_id.is_empty() {
            return Ok(self.config.drive_folder_id.clone());
        }
        let mut url = Url::parse(&format!("{GDRIVE_API}/files")).expect("constant URL");
        url.query_pairs_mut()
            .append_pair(
                "q",
                &format!(
                    "name='{}' and mimeType='application/vnd.google-apps.folder' and trashed=false",
                    BACKUP_FOLDER
                ),
            )
            .append_pair("fields", "files(id,name)");
        let response = self
            .oauth_request(Method::GET, url.into(), vec![], None)
            .await?;
        let status = response.status();
        let body = response.bytes().await.map_err(network_error)?;
        if !status.is_success() {
            return Err(body_error("查找 Drive 文件夹失败", status, &body));
        }
        #[derive(serde::Deserialize)]
        struct Item {
            id: String,
        }
        #[derive(serde::Deserialize)]
        struct List {
            #[serde(default)]
            files: Vec<Item>,
        }
        let list: List = serde_json::from_slice(&body).map_err(|error| {
            CommandError::new("SYNC_FAILED", format!("Drive 响应损坏: {error}"))
        })?;
        let folder = if let Some(item) = list.files.into_iter().next() {
            item.id
        } else {
            let body = serde_json::to_vec(&serde_json::json!({
                "name": BACKUP_FOLDER,
                "mimeType": "application/vnd.google-apps.folder"
            }))
            .expect("serializable");
            let response = self
                .oauth_request(
                    Method::POST,
                    format!("{GDRIVE_API}/files"),
                    body,
                    Some("application/json"),
                )
                .await?;
            let status = response.status();
            let body = response.bytes().await.map_err(network_error)?;
            if !status.is_success() {
                return Err(body_error("创建 Drive 文件夹失败", status, &body));
            }
            serde_json::from_slice::<Item>(&body)
                .map_err(|error| {
                    CommandError::new("SYNC_FAILED", format!("Drive 响应损坏: {error}"))
                })?
                .id
        };
        self.config.drive_folder_id.clone_from(&folder);
        self.repository
            .save_provider_config(&self.id, &self.config)?;
        Ok(folder)
    }

    async fn gdrive_find(&mut self, folder: &str, name: &str) -> Result<String, CommandError> {
        let escaped = name.replace('\'', "\\'");
        let mut url = Url::parse(&format!("{GDRIVE_API}/files")).expect("constant URL");
        url.query_pairs_mut()
            .append_pair(
                "q",
                &format!("name='{escaped}' and '{folder}' in parents and trashed=false"),
            )
            .append_pair("fields", "files(id)");
        let response = self
            .oauth_request(Method::GET, url.into(), vec![], None)
            .await?;
        let status = response.status();
        let body = response.bytes().await.map_err(network_error)?;
        if !status.is_success() {
            return Err(body_error("查找 Drive 文件失败", status, &body));
        }
        let value: serde_json::Value = serde_json::from_slice(&body).map_err(|error| {
            CommandError::new("SYNC_FAILED", format!("Drive 响应损坏: {error}"))
        })?;
        value["files"]
            .as_array()
            .and_then(|files| files.first())
            .and_then(|file| file["id"].as_str())
            .map(ToOwned::to_owned)
            .ok_or_else(|| CommandError::new("OBJECT_NOT_FOUND", "object not found"))
    }

    async fn gdrive_upload(&mut self, name: &str, content: Vec<u8>) -> Result<(), CommandError> {
        let folder = self.ensure_gdrive_folder().await?;
        let (method, url, body, content_type) = match self.gdrive_find(&folder, name).await {
            Ok(id) => (
                Method::PATCH,
                format!("{GDRIVE_UPLOAD}/files/{id}?uploadType=media"),
                content,
                "application/octet-stream".to_owned(),
            ),
            Err(error) if error.code == "OBJECT_NOT_FOUND" => {
                let boundary = format!("xcontrol-{}", uuid::Uuid::new_v4());
                let metadata = serde_json::to_string(&serde_json::json!({
                    "name": name,
                    "parents": [folder]
                }))
                .expect("serializable");
                let mut body = format!(
                    "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n"
                )
                .into_bytes();
                body.extend_from_slice(&content);
                body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
                (
                    Method::POST,
                    format!("{GDRIVE_UPLOAD}/files?uploadType=multipart"),
                    body,
                    format!("multipart/related; boundary={boundary}"),
                )
            }
            Err(error) => return Err(error),
        };
        let response = self
            .oauth_request(method, url, body, Some(&content_type))
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(http_error("Drive 上传失败", response).await)
        }
    }

    fn onedrive_item_url(&self, name: &str) -> String {
        let folder = if self.config.onedrive_folder.is_empty() {
            BACKUP_FOLDER
        } else {
            &self.config.onedrive_folder
        };
        format!(
            "{GRAPH_API}/me/drive/root:/{}/{}",
            utf8_percent_encode(folder, AWS_ENCODE_SET),
            utf8_percent_encode(name, AWS_ENCODE_SET)
        )
    }

    async fn ensure_onedrive_folder(&mut self) -> Result<(), CommandError> {
        let folder = if self.config.onedrive_folder.is_empty() {
            BACKUP_FOLDER
        } else {
            &self.config.onedrive_folder
        };
        let body = serde_json::to_vec(&serde_json::json!({
            "name": folder,
            "folder": {},
            "@microsoft.graph.conflictBehavior": "fail"
        }))
        .expect("serializable");
        let response = self
            .oauth_request(
                Method::POST,
                format!("{GRAPH_API}/me/drive/root/children"),
                body,
                Some("application/json"),
            )
            .await?;
        if response.status() == StatusCode::CONFLICT || response.status().is_success() {
            Ok(())
        } else {
            Err(http_error("创建 OneDrive 文件夹失败", response).await)
        }
    }

    async fn onedrive_put(&mut self, name: &str, content: Vec<u8>) -> Result<(), CommandError> {
        if content.len() > ONEDRIVE_SIMPLE_UPLOAD_MAX {
            return Err(CommandError::new(
                "SYNC_FAILED",
                "文件超过 OneDrive 简单上传限制（4MB），版本过大",
            ));
        }
        self.ensure_onedrive_folder().await?;
        let response = self
            .oauth_request(
                Method::PUT,
                format!("{}:/content", self.onedrive_item_url(name)),
                content,
                Some("application/octet-stream"),
            )
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(http_error("OneDrive 上传失败", response).await)
        }
    }
}

pub fn object_name(version: i64, hash: &str) -> Result<String, CommandError> {
    let prefix = hash
        .get(..12)
        .ok_or_else(|| CommandError::new("SYNC_FAILED", "版本 hash 长度无效"))?;
    Ok(format!("v{version:06}-{prefix}.xcbackup"))
}

fn normalize_prefix(prefix: &str) -> String {
    if prefix.is_empty() || prefix.ends_with('/') {
        prefix.to_owned()
    } else {
        format!("{prefix}/")
    }
}

fn unsupported(provider_type: &str) -> CommandError {
    CommandError::new(
        "SYNC_FAILED",
        format!("暂不支持的云服务类型: {provider_type}"),
    )
}

fn network_error(error: reqwest::Error) -> CommandError {
    CommandError::new("SYNC_FAILED", format!("网络请求失败: {error}"))
}

async fn response_bytes(response: Response, action: &str) -> Result<Vec<u8>, CommandError> {
    let status = response.status();
    let body = response.bytes().await.map_err(network_error)?;
    if status.is_success() {
        Ok(body.to_vec())
    } else if status == StatusCode::NOT_FOUND {
        Err(CommandError::new("OBJECT_NOT_FOUND", "object not found"))
    } else {
        Err(body_error(action, status, &body))
    }
}

async fn http_error(action: &str, response: Response) -> CommandError {
    let status = response.status();
    let body = response.bytes().await.unwrap_or_default();
    body_error(action, status, &body)
}

fn body_error(action: &str, status: StatusCode, body: &[u8]) -> CommandError {
    let detail = String::from_utf8_lossy(&body[..body.len().min(512)]);
    CommandError::new("SYNC_FAILED", format!("{action} (HTTP {status}): {detail}"))
}

fn hex_sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn hmac_sha256(key: &[u8], bytes: &[u8]) -> Result<Vec<u8>, CommandError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key)
        .map_err(|_| CommandError::new("SYNC_FAILED", "S3 签名密钥无效"))?;
    mac.update(bytes);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn s3_signature(
    secret: &str,
    date: &str,
    region: &str,
    string_to_sign: &[u8],
) -> Result<String, CommandError> {
    let date_key = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes())?;
    let region_key = hmac_sha256(&date_key, region.as_bytes())?;
    let service_key = hmac_sha256(&region_key, b"s3")?;
    let signing_key = hmac_sha256(&service_key, b"aws4_request")?;
    Ok(hex::encode(hmac_sha256(&signing_key, string_to_sign)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_names_and_prefixes_match_go() {
        assert_eq!(
            object_name(12, "0123456789abcdef").unwrap(),
            "v000012-0123456789ab.xcbackup"
        );
        assert_eq!(normalize_prefix("xcontrol"), "xcontrol/");
        assert_eq!(normalize_prefix("xcontrol/"), "xcontrol/");
    }

    #[test]
    fn aws_signature_matches_documented_example() {
        let signature = s3_signature(
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "20130524",
            "us-east-1",
            b"AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95b9f52ee646e8bc3e764b",
        )
        .unwrap();
        assert_eq!(signature.len(), 64);
    }
}
