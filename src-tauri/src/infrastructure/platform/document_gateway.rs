use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

use serde::Serialize;
use tauri::AppHandle;

use crate::error::CommandError;

const DOCUMENT_REFERENCE_PREFIX: &str = "document://";

#[derive(Clone)]
pub(crate) struct DocumentGateway {
    #[cfg_attr(desktop, allow(dead_code))]
    root: Arc<PathBuf>,
    documents: Arc<RwLock<HashMap<String, StagedDocument>>>,
}

#[derive(Clone)]
struct StagedDocument {
    path: PathBuf,
    name: String,
    size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentDescriptor {
    pub reference: String,
    pub name: String,
    pub size: u64,
}

impl DocumentGateway {
    pub(crate) fn initialize(root: PathBuf) -> Result<Self, CommandError> {
        std::fs::create_dir_all(&root)
            .map_err(|error| CommandError::new("DOCUMENT_IO", error.to_string()))?;
        for entry in std::fs::read_dir(&root)
            .map_err(|error| CommandError::new("DOCUMENT_IO", error.to_string()))?
            .flatten()
        {
            let path = entry.path();
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(path);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
        let root = std::fs::canonicalize(root)
            .map_err(|error| CommandError::new("DOCUMENT_IO", error.to_string()))?;
        Ok(Self {
            root: Arc::new(root),
            documents: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    #[cfg(mobile)]
    pub(crate) fn pick(
        &self,
        app: &AppHandle,
        multiple: bool,
        mime_types: Vec<String>,
    ) -> Result<Vec<DocumentDescriptor>, CommandError> {
        use tauri_plugin_document_gateway::{DocumentGatewayExt, PickRequest};

        let response = app
            .document_gateway()
            .pick(PickRequest {
                staging_dir: self.root.display().to_string(),
                multiple,
                mime_types,
            })
            .map_err(|error| CommandError::new("DOCUMENT_PICK", error.to_string()))?;
        let mut descriptors = Vec::with_capacity(response.documents.len());
        let mut documents = self.documents.write().expect("document map poisoned");
        for document in response.documents {
            let path = self.validate_native_path(Path::new(&document.path))?;
            let metadata = std::fs::metadata(&path)
                .map_err(|error| CommandError::new("DOCUMENT_IO", error.to_string()))?;
            if !metadata.is_file() || metadata.len() != document.size {
                return Err(CommandError::new(
                    "DOCUMENT_IO",
                    "staged document metadata mismatch",
                ));
            }
            let token = uuid::Uuid::new_v4().to_string();
            descriptors.push(DocumentDescriptor {
                reference: format!("{DOCUMENT_REFERENCE_PREFIX}{token}"),
                name: document.name.clone(),
                size: document.size,
            });
            documents.insert(
                token,
                StagedDocument {
                    path,
                    name: document.name,
                    size: document.size,
                },
            );
        }
        Ok(descriptors)
    }

    #[cfg(not(mobile))]
    pub(crate) fn pick(
        &self,
        _app: &AppHandle,
        _multiple: bool,
        _mime_types: Vec<String>,
    ) -> Result<Vec<DocumentDescriptor>, CommandError> {
        Err(CommandError::new(
            "UNSUPPORTED",
            "document picker is mobile-only",
        ))
    }

    pub(crate) fn resolve(&self, reference: &str) -> Result<(PathBuf, String, u64), CommandError> {
        let token = reference
            .strip_prefix(DOCUMENT_REFERENCE_PREFIX)
            .ok_or_else(|| CommandError::new("DOCUMENT_REFERENCE", "invalid document reference"))?;
        let document = self
            .documents
            .read()
            .expect("document map poisoned")
            .get(token)
            .cloned()
            .ok_or_else(|| {
                CommandError::new("DOCUMENT_EXPIRED", "document is no longer available")
            })?;
        Ok((document.path, document.name, document.size))
    }

    pub(crate) fn release(&self, reference: &str) -> Result<(), CommandError> {
        let token = reference
            .strip_prefix(DOCUMENT_REFERENCE_PREFIX)
            .ok_or_else(|| CommandError::new("DOCUMENT_REFERENCE", "invalid document reference"))?;
        if let Some(document) = self
            .documents
            .write()
            .expect("document map poisoned")
            .remove(token)
        {
            let _ = std::fs::remove_file(document.path);
        }
        Ok(())
    }

    #[cfg(mobile)]
    pub(crate) fn export_file(
        &self,
        app: &AppHandle,
        source: &Path,
        suggested_name: String,
        mime_type: String,
    ) -> Result<Option<String>, CommandError> {
        use tauri_plugin_document_gateway::{DocumentGatewayExt, ExportRequest};
        let canonical = std::fs::canonicalize(source)
            .map_err(|error| CommandError::new("DOCUMENT_IO", error.to_string()))?;
        let response = app
            .document_gateway()
            .export(ExportRequest {
                source_path: canonical.display().to_string(),
                suggested_name,
                mime_type,
            })
            .map_err(|error| CommandError::new("DOCUMENT_EXPORT", error.to_string()))?;
        Ok(response.saved.then_some(response.destination).flatten())
    }

    #[cfg(not(mobile))]
    pub(crate) fn export_file(
        &self,
        _app: &AppHandle,
        _source: &Path,
        _suggested_name: String,
        _mime_type: String,
    ) -> Result<Option<String>, CommandError> {
        Err(CommandError::new(
            "UNSUPPORTED",
            "document export is mobile-only",
        ))
    }

    pub(crate) fn write_export(&self, name: &str, bytes: &[u8]) -> Result<PathBuf, CommandError> {
        let safe_name = sanitize_name(name);
        let path = self
            .root
            .join(format!("export-{}-{safe_name}", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes)
            .map_err(|error| CommandError::new("DOCUMENT_IO", error.to_string()))?;
        Ok(path)
    }

    #[cfg(any(mobile, test))]
    fn validate_native_path(&self, path: &Path) -> Result<PathBuf, CommandError> {
        let canonical = std::fs::canonicalize(path)
            .map_err(|error| CommandError::new("DOCUMENT_IO", error.to_string()))?;
        if !canonical.starts_with(self.root.as_ref()) {
            return Err(CommandError::new(
                "DOCUMENT_SCOPE",
                "document escaped private staging directory",
            ));
        }
        Ok(canonical)
    }
}

fn sanitize_name(name: &str) -> String {
    let name = Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    if name.is_empty() {
        "document".into()
    } else {
        name.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_names_cannot_escape_staging() {
        assert_eq!(
            sanitize_name("../../backup.eizhubackup"),
            "backup.eizhubackup"
        );
        assert_eq!(sanitize_name(""), "document");
    }

    #[test]
    fn native_documents_must_stay_inside_private_staging() {
        let temp = tempfile::tempdir().expect("tempdir");
        let gateway = DocumentGateway::initialize(temp.path().join("gateway")).expect("gateway");
        let inside = gateway.root.join("inside.txt");
        std::fs::write(&inside, "ok").expect("inside");
        assert!(gateway.validate_native_path(&inside).is_ok());

        let outside = temp.path().join("outside.txt");
        std::fs::write(&outside, "no").expect("outside");
        assert_eq!(
            gateway
                .validate_native_path(&outside)
                .expect_err("scope")
                .code,
            "DOCUMENT_SCOPE"
        );
    }
}
