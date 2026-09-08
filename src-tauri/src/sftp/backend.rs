use std::{path::PathBuf, sync::Arc, time::SystemTime};

use chrono::{DateTime, Utc};
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ssh::transport::ConnectedRoute;

pub(crate) enum FileBackend {
    Local,
    Remote {
        sftp: Arc<SftpSession>,
        _route: ConnectedRoute,
    },
}

pub(crate) type BackendReader = Box<dyn tokio::io::AsyncRead + Unpin + Send>;
pub(crate) type BackendWriter = Box<dyn tokio::io::AsyncWrite + Unpin + Send>;

#[derive(Debug, Clone)]
pub(crate) struct FileInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: SystemTime,
    pub mode: String,
}

impl FileBackend {
    pub async fn close(&self) {
        if let Self::Remote { sftp, .. } = self {
            let _ = sftp.close().await;
        }
    }

    pub async fn exec(&self, command: &str) -> Result<(String, i32), String> {
        let Self::Remote { _route: route, .. } = self else {
            return Err("command execution is unavailable for local sessions".into());
        };
        let mut channel = route
            .handle
            .channel_open_session()
            .await
            .map_err(|error| error.to_string())?;
        channel
            .exec(true, command)
            .await
            .map_err(|error| error.to_string())?;
        let mut output = Vec::new();
        let mut exit_code = 0;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => exit_code = exit_status as i32,
                _ => {}
            }
        }
        Ok((String::from_utf8_lossy(&output).into_owned(), exit_code))
    }

    pub async fn list(&self, path: &str) -> Result<Vec<FileInfo>, String> {
        match self {
            Self::Local => {
                let mut directory = tokio::fs::read_dir(posix_to_os(path))
                    .await
                    .map_err(file_error)?;
                let mut result = Vec::new();
                while let Some(entry) = directory.next_entry().await.map_err(file_error)? {
                    let metadata = entry.metadata().await.map_err(file_error)?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    result.push(FileInfo {
                        path: join_path(path, &name),
                        name,
                        is_dir: metadata.is_dir(),
                        size: metadata.len(),
                        modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                        mode: local_mode(&metadata),
                    });
                }
                Ok(result)
            }
            Self::Remote { sftp, .. } => {
                sftp.read_dir(path)
                    .await
                    .map_err(sftp_error)
                    .map(|entries| {
                        entries
                            .map(|entry| {
                                let metadata = entry.metadata();
                                FileInfo {
                                    name: entry.file_name(),
                                    path: entry.path(),
                                    is_dir: metadata.file_type().is_dir(),
                                    size: metadata.len(),
                                    modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                                    mode: metadata.permissions().to_string(),
                                }
                            })
                            .collect()
                    })
            }
        }
    }

    pub async fn stat(&self, path: &str) -> Result<FileInfo, String> {
        match self {
            Self::Local => {
                let metadata = tokio::fs::metadata(posix_to_os(path))
                    .await
                    .map_err(file_error)?;
                Ok(FileInfo {
                    name: base_name(path),
                    path: clean_path(path),
                    is_dir: metadata.is_dir(),
                    size: metadata.len(),
                    modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    mode: local_mode(&metadata),
                })
            }
            Self::Remote { sftp, .. } => {
                let metadata = sftp.metadata(path).await.map_err(sftp_error)?;
                Ok(FileInfo {
                    name: base_name(path),
                    path: clean_path(path),
                    is_dir: metadata.file_type().is_dir(),
                    size: metadata.len(),
                    modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    mode: metadata.permissions().to_string(),
                })
            }
        }
    }

    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        match self {
            Self::Local => tokio::fs::create_dir(posix_to_os(path))
                .await
                .map_err(file_error),
            Self::Remote { sftp, .. } => sftp.create_dir(path).await.map_err(sftp_error),
        }
    }

    pub async fn mkdir_all(&self, path: &str) -> Result<(), String> {
        if matches!(self, Self::Local) {
            return tokio::fs::create_dir_all(posix_to_os(path))
                .await
                .map_err(file_error);
        }
        let mut current = String::new();
        for component in clean_path(path)
            .split('/')
            .filter(|value| !value.is_empty())
        {
            current.push('/');
            current.push_str(component);
            if self.stat(&current).await.is_err() {
                self.mkdir(&current).await?;
            }
        }
        Ok(())
    }

    pub async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), String> {
        match self {
            Self::Local => tokio::fs::rename(posix_to_os(old_path), posix_to_os(new_path))
                .await
                .map_err(file_error),
            Self::Remote { sftp, .. } => sftp.rename(old_path, new_path).await.map_err(sftp_error),
        }
    }

    pub async fn remove_file(&self, path: &str) -> Result<(), String> {
        match self {
            Self::Local => tokio::fs::remove_file(posix_to_os(path))
                .await
                .map_err(file_error),
            Self::Remote { sftp, .. } => sftp.remove_file(path).await.map_err(sftp_error),
        }
    }

    pub async fn remove_dir(&self, path: &str) -> Result<(), String> {
        match self {
            Self::Local => tokio::fs::remove_dir(posix_to_os(path))
                .await
                .map_err(file_error),
            Self::Remote { sftp, .. } => sftp.remove_dir(path).await.map_err(sftp_error),
        }
    }

    pub async fn read(&self, path: &str, limit: Option<usize>) -> Result<Vec<u8>, String> {
        let mut output = Vec::new();
        match self {
            Self::Local => {
                let file = tokio::fs::File::open(posix_to_os(path))
                    .await
                    .map_err(file_error)?;
                match limit {
                    Some(limit) => file.take((limit + 1) as u64).read_to_end(&mut output).await,
                    None => file.take(u64::MAX).read_to_end(&mut output).await,
                }
                .map_err(file_error)?;
            }
            Self::Remote { sftp, .. } => {
                let file = sftp.open(path).await.map_err(sftp_error)?;
                match limit {
                    Some(limit) => file.take((limit + 1) as u64).read_to_end(&mut output).await,
                    None => file.take(u64::MAX).read_to_end(&mut output).await,
                }
                .map_err(file_error)?;
            }
        }
        Ok(output)
    }

    pub async fn open_read(&self, path: &str) -> Result<BackendReader, String> {
        match self {
            Self::Local => tokio::fs::File::open(posix_to_os(path))
                .await
                .map(|file| Box::new(file) as BackendReader)
                .map_err(file_error),
            Self::Remote { sftp, .. } => sftp
                .open(path)
                .await
                .map(|file| Box::new(file) as BackendReader)
                .map_err(sftp_error),
        }
    }

    pub async fn open_write(&self, path: &str) -> Result<BackendWriter, String> {
        match self {
            Self::Local => tokio::fs::File::create(posix_to_os(path))
                .await
                .map(|file| Box::new(file) as BackendWriter)
                .map_err(file_error),
            Self::Remote { sftp, .. } => sftp
                .create(path)
                .await
                .map(|file| Box::new(file) as BackendWriter)
                .map_err(sftp_error),
        }
    }

    pub async fn write(&self, path: &str, data: &[u8]) -> Result<(), String> {
        match self {
            Self::Local => tokio::fs::write(posix_to_os(path), data)
                .await
                .map_err(file_error),
            Self::Remote { sftp, .. } => {
                let mut file = sftp.create(path).await.map_err(sftp_error)?;
                file.write_all(data).await.map_err(file_error)?;
                file.close().await.map_err(file_error)
            }
        }
    }
}

pub(crate) fn clean_path(path: &str) -> String {
    let absolute = path.starts_with('/');
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
    let cleaned = components.join("/");
    if absolute {
        if cleaned.is_empty() {
            "/".into()
        } else {
            format!("/{cleaned}")
        }
    } else if cleaned.is_empty() {
        ".".into()
    } else {
        cleaned
    }
}

pub(crate) fn join_path(parent: &str, child: &str) -> String {
    clean_path(&format!("{}/{}", parent.trim_end_matches('/'), child))
}

pub(crate) fn base_name(path: &str) -> String {
    clean_path(path)
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_owned()
}

pub(crate) fn format_time(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339()
}

pub(crate) fn local_home_dir() -> String {
    dirs::home_dir()
        .as_deref()
        .map(local_path_to_api)
        .unwrap_or_else(|| "/".into())
}

#[cfg(windows)]
pub(crate) fn local_path_to_api(path: &std::path::Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if value.as_bytes().get(1) == Some(&b':') {
        format!("/{value}")
    } else {
        value
    }
}

#[cfg(not(windows))]
pub(crate) fn local_path_to_api(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(windows)]
fn posix_to_os(path: &str) -> PathBuf {
    let clean = clean_path(path);
    if clean.len() > 3 && clean.as_bytes()[0] == b'/' && clean.as_bytes()[2] == b':' {
        PathBuf::from(clean.trim_start_matches('/').replace('/', "\\"))
    } else {
        PathBuf::from(clean.replace('/', "\\"))
    }
}

#[cfg(not(windows))]
fn posix_to_os(path: &str) -> PathBuf {
    PathBuf::from(clean_path(path))
}

#[cfg(unix)]
fn local_mode(metadata: &std::fs::Metadata) -> String {
    use std::os::unix::fs::PermissionsExt;
    format!("{:o}", metadata.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn local_mode(metadata: &std::fs::Metadata) -> String {
    if metadata.permissions().readonly() {
        "r--r--r--"
    } else {
        "rw-rw-rw-"
    }
    .into()
}

fn file_error(error: std::io::Error) -> String {
    error.to_string()
}

fn sftp_error(error: russh_sftp::client::error::Error) -> String {
    error.to_string()
}
