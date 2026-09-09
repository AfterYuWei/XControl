//! Process-visible local filesystem path adapter.
//!
//! Mobile currently exposes only paths visible inside the application sandbox. Content URI and
//! security-scoped URL support belongs at this boundary rather than in the SFTP feature.

use std::path::{Path, PathBuf};

pub(crate) fn home_dir() -> String {
    dirs::home_dir()
        .as_deref()
        .map(path_to_api)
        .unwrap_or_else(|| "/".into())
}

#[cfg(windows)]
pub(crate) fn path_to_api(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if value.as_bytes().get(1) == Some(&b':') {
        format!("/{value}")
    } else {
        value
    }
}

#[cfg(not(windows))]
pub(crate) fn path_to_api(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(windows)]
pub(crate) fn path_from_api(path: &str) -> PathBuf {
    let clean = clean_api_path(path);
    if clean.len() > 3 && clean.as_bytes()[0] == b'/' && clean.as_bytes()[2] == b':' {
        PathBuf::from(clean.trim_start_matches('/').replace('/', "\\"))
    } else {
        PathBuf::from(clean.replace('/', "\\"))
    }
}

#[cfg(not(windows))]
pub(crate) fn path_from_api(path: &str) -> PathBuf {
    PathBuf::from(clean_api_path(path))
}

#[cfg(unix)]
pub(crate) fn mode(metadata: &std::fs::Metadata) -> String {
    use std::os::unix::fs::PermissionsExt;
    format!("{:o}", metadata.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
pub(crate) fn mode(metadata: &std::fs::Metadata) -> String {
    if metadata.permissions().readonly() {
        "r--r--r--"
    } else {
        "rw-rw-rw-"
    }
    .into()
}

fn clean_api_path(path: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_paths_cannot_escape_their_root() {
        assert_eq!(path_to_api(&path_from_api("/a/../../b")), "/b");
        assert_eq!(path_to_api(&path_from_api("a/../b")), "b");
    }
}
