use std::{sync::Arc, time::SystemTime};

use chrono::{DateTime, Utc};
use russh_sftp::client::SftpSession;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::{infrastructure::platform::local_files, ssh::transport::ConnectedRoute};

use super::SftpError;

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

    pub async fn exec(&self, command: &str) -> Result<(String, i32), SftpError> {
        let Self::Remote { _route: route, .. } = self else {
            return Err("command execution is unavailable for local sessions".into());
        };
        Ok(route
            .exec(command)
            .await
            .map_err(|error| error.to_string())?)
    }

    pub async fn list(&self, path: &str) -> Result<Vec<FileInfo>, SftpError> {
        match self {
            Self::Local => {
                let mut directory = tokio::fs::read_dir(local_files::path_from_api(path))
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
                        mode: local_files::mode(&metadata),
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

    pub async fn stat(&self, path: &str) -> Result<FileInfo, SftpError> {
        match self {
            Self::Local => {
                let metadata = tokio::fs::metadata(local_files::path_from_api(path))
                    .await
                    .map_err(file_error)?;
                Ok(FileInfo {
                    name: base_name(path),
                    path: clean_path(path),
                    is_dir: metadata.is_dir(),
                    size: metadata.len(),
                    modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    mode: local_files::mode(&metadata),
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

    pub async fn mkdir(&self, path: &str) -> Result<(), SftpError> {
        match self {
            Self::Local => tokio::fs::create_dir(local_files::path_from_api(path))
                .await
                .map_err(file_error),
            Self::Remote { sftp, .. } => sftp.create_dir(path).await.map_err(sftp_error),
        }
    }

    pub async fn mkdir_all(&self, path: &str) -> Result<(), SftpError> {
        if matches!(self, Self::Local) {
            return tokio::fs::create_dir_all(local_files::path_from_api(path))
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

    pub async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), SftpError> {
        match self {
            Self::Local => tokio::fs::rename(
                local_files::path_from_api(old_path),
                local_files::path_from_api(new_path),
            )
            .await
            .map_err(file_error),
            Self::Remote { sftp, .. } => sftp.rename(old_path, new_path).await.map_err(sftp_error),
        }
    }

    pub async fn remove_file(&self, path: &str) -> Result<(), SftpError> {
        match self {
            Self::Local => tokio::fs::remove_file(local_files::path_from_api(path))
                .await
                .map_err(file_error),
            Self::Remote { sftp, .. } => sftp.remove_file(path).await.map_err(sftp_error),
        }
    }

    pub async fn remove_dir(&self, path: &str) -> Result<(), SftpError> {
        match self {
            Self::Local => tokio::fs::remove_dir(local_files::path_from_api(path))
                .await
                .map_err(file_error),
            Self::Remote { sftp, .. } => sftp.remove_dir(path).await.map_err(sftp_error),
        }
    }

    pub async fn read(&self, path: &str, limit: Option<usize>) -> Result<Vec<u8>, SftpError> {
        let mut output = Vec::new();
        match self {
            Self::Local => {
                let file = tokio::fs::File::open(local_files::path_from_api(path))
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

    pub async fn open_read(&self, path: &str) -> Result<BackendReader, SftpError> {
        match self {
            Self::Local => tokio::fs::File::open(local_files::path_from_api(path))
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

    pub async fn open_write(&self, path: &str) -> Result<BackendWriter, SftpError> {
        match self {
            Self::Local => tokio::fs::File::create(local_files::path_from_api(path))
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

    pub async fn write(&self, path: &str, data: &[u8]) -> Result<(), SftpError> {
        match self {
            Self::Local => tokio::fs::write(local_files::path_from_api(path), data)
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
    local_files::home_dir()
}

pub(crate) fn local_path_to_api(path: &std::path::Path) -> String {
    local_files::path_to_api(path)
}

fn file_error(error: std::io::Error) -> SftpError {
    SftpError::Backend(error.to_string())
}

fn sftp_error(error: russh_sftp::client::error::Error) -> SftpError {
    SftpError::Backend(error.to_string())
}
