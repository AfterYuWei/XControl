use chrono::{Local, SecondsFormat};

use crate::{error::CommandError, infrastructure::database::Database};

use super::{repository::SnippetRepository, Snippet, SnippetCreateRequest, SnippetUpdateRequest};

#[derive(Clone)]
pub(crate) struct SnippetService {
    repository: SnippetRepository,
}

impl SnippetService {
    pub(crate) fn new(database: Database) -> Self {
        Self {
            repository: SnippetRepository::new(database),
        }
    }

    pub(crate) fn list(&self) -> Result<Vec<Snippet>, CommandError> {
        self.repository.list()
    }

    fn get(&self, id: &str) -> Result<Option<Snippet>, CommandError> {
        self.repository.get(id)
    }

    pub(crate) fn create(&self, request: SnippetCreateRequest) -> Result<Snippet, CommandError> {
        if request.name.is_empty() || request.content.is_empty() {
            return Err(CommandError::new(
                "VALIDATION",
                "name and content are required",
            ));
        }
        let now = Local::now().to_rfc3339_opts(SecondsFormat::AutoSi, true);
        let snippet = Snippet {
            id: uuid::Uuid::new_v4().to_string(),
            name: request.name,
            content: request.content,
            description: request.description,
            tags: request.tags,
            is_global: request.is_global.unwrap_or(true),
            created_at: now.clone(),
            updated_at: now,
        };
        self.repository.insert(&snippet)?;
        Ok(snippet)
    }

    pub(crate) fn update(
        &self,
        id: &str,
        request: SnippetUpdateRequest,
    ) -> Result<Snippet, CommandError> {
        let mut snippet = self.get(id)?.ok_or_else(|| {
            // Preserve the legacy Go handler contract for a missing row.
            CommandError::new("DB_ERROR", "sql: no rows in result set")
        })?;
        if let Some(name) = request.name {
            snippet.name = name;
        }
        if let Some(content) = request.content {
            snippet.content = content;
        }
        if let Some(description) = request.description {
            snippet.description = description;
        }
        if let Some(tags) = request.tags {
            snippet.tags = tags;
        }
        if let Some(is_global) = request.is_global {
            snippet.is_global = is_global;
        }
        snippet.updated_at = Local::now().to_rfc3339_opts(SecondsFormat::AutoSi, true);
        self.repository.update(&snippet)?;
        Ok(snippet)
    }

    pub(crate) fn delete(&self, id: &str) -> Result<(), CommandError> {
        self.repository.delete(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> (tempfile::TempDir, SnippetService) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::initialize(directory.path().join("xcontrol.db")).unwrap();
        let service = SnippetService::new(database);
        (directory, service)
    }

    #[test]
    fn crud_preserves_defaults_and_partial_updates() {
        let (_directory, service) = service();
        let created = service
            .create(SnippetCreateRequest {
                name: "磁盘".into(),
                content: "df -h".into(),
                description: String::new(),
                tags: vec![],
                is_global: None,
            })
            .unwrap();
        assert!(created.is_global);
        assert!(created.tags.is_empty());

        let updated = service
            .update(
                &created.id,
                SnippetUpdateRequest {
                    name: Some("磁盘空间".into()),
                    content: None,
                    description: None,
                    tags: Some(vec!["linux".into()]),
                    is_global: Some(false),
                },
            )
            .unwrap();
        assert_eq!(updated.name, "磁盘空间");
        assert_eq!(updated.content, "df -h");
        assert_eq!(updated.tags, vec!["linux"]);
        assert!(!updated.is_global);
        assert_eq!(service.list().unwrap(), vec![updated.clone()]);

        service.delete(&created.id).unwrap();
        assert!(service.list().unwrap().is_empty());
        service.delete(&created.id).unwrap();
    }

    #[test]
    fn create_validation_matches_go_handler() {
        let (_directory, service) = service();
        let error = service
            .create(SnippetCreateRequest {
                name: String::new(),
                content: "pwd".into(),
                description: String::new(),
                tags: vec![],
                is_global: None,
            })
            .unwrap_err();
        assert_eq!(error.code, "VALIDATION");
        assert_eq!(error.message, "name and content are required");
    }

    #[test]
    fn update_missing_id_matches_existing_error_contract() {
        let (_directory, service) = service();
        let error = service
            .update(
                "missing",
                SnippetUpdateRequest {
                    name: None,
                    content: None,
                    description: None,
                    tags: None,
                    is_global: None,
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "DB_ERROR");
    }
}
