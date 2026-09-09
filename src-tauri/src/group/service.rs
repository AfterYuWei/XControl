use chrono::{Local, SecondsFormat};

use crate::{error::CommandError, infrastructure::database::Database};

use super::{repository::GroupRepository, Group, GroupCreateRequest, GroupUpdateRequest};

#[derive(Clone)]
pub(crate) struct GroupService {
    repository: GroupRepository,
}

impl GroupService {
    pub(crate) fn new(database: Database) -> Self {
        Self {
            repository: GroupRepository::new(database),
        }
    }

    pub(crate) fn list(&self) -> Result<Vec<Group>, CommandError> {
        self.repository.list()
    }

    fn get(&self, id: &str) -> Result<Option<Group>, CommandError> {
        self.repository.get(id)
    }

    pub(crate) fn create(&self, request: GroupCreateRequest) -> Result<Group, CommandError> {
        if request.name.is_empty() {
            return Err(CommandError::new("VALIDATION", "name is required"));
        }
        let group = Group {
            id: uuid::Uuid::new_v4().to_string(),
            name: request.name,
            parent_id: request.parent_id.filter(|id| !id.is_empty()),
            icon: request
                .icon
                .filter(|icon| !icon.is_empty())
                .unwrap_or_else(|| "folder".into()),
            sort_order: 0,
            created_at: Local::now().to_rfc3339_opts(SecondsFormat::AutoSi, true),
        };
        self.repository.insert(&group)?;
        Ok(group)
    }

    pub(crate) fn update(
        &self,
        id: &str,
        request: GroupUpdateRequest,
    ) -> Result<Group, CommandError> {
        let mut group = self.get(id)?.ok_or_else(|| {
            // Preserve the legacy Go handler contract for a missing row.
            CommandError::new("DB_ERROR", "sql: no rows in result set")
        })?;
        if let Some(name) = request.name {
            group.name = name;
        }
        if let Some(parent_id) = request.parent_id {
            group.parent_id = (!parent_id.is_empty()).then_some(parent_id);
        }
        if let Some(icon) = request.icon {
            group.icon = icon;
        }
        self.repository.update(&group)?;
        Ok(group)
    }

    pub(crate) fn delete(&self, id: &str) -> Result<(), CommandError> {
        let profile_count = self.repository.delete(id)?;
        if profile_count > 0 {
            return Err(CommandError::new(
                "GROUP_NOT_EMPTY",
                format!("该分组下仍有 {profile_count} 台服务器，请先移动或删除后再删除分组"),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> (tempfile::TempDir, GroupService) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::initialize(directory.path().join("xcontrol.db")).unwrap();
        let service = GroupService::new(database);
        (directory, service)
    }

    #[test]
    fn crud_preserves_defaults_ordering_and_child_detach() {
        let (_directory, service) = service();
        let parent = service
            .create(GroupCreateRequest {
                name: "生产".into(),
                parent_id: None,
                icon: None,
            })
            .unwrap();
        assert_eq!(parent.icon, "folder");
        assert_eq!(parent.sort_order, 0);

        let child = service
            .create(GroupCreateRequest {
                name: "子组".into(),
                parent_id: Some(parent.id.clone()),
                icon: Some("boxes".into()),
            })
            .unwrap();
        let updated = service
            .update(
                &child.id,
                GroupUpdateRequest {
                    name: Some("应用".into()),
                    parent_id: None,
                    icon: None,
                },
            )
            .unwrap();
        assert_eq!(updated.parent_id.as_deref(), Some(parent.id.as_str()));
        assert_eq!(updated.icon, "boxes");

        service.delete(&parent.id).unwrap();
        let detached = service.get(&child.id).unwrap().unwrap();
        assert_eq!(detached.parent_id, None);
        assert_eq!(service.list().unwrap(), vec![detached]);
    }

    #[test]
    fn delete_rejects_non_empty_group_with_compatible_error() {
        let (_directory, service) = service();
        let group = service
            .create(GroupCreateRequest {
                name: "生产".into(),
                parent_id: None,
                icon: None,
            })
            .unwrap();
        let connection = service.repository.database.connect().unwrap();
        connection
            .execute(
                "INSERT INTO profiles (id, name, host, group_id) VALUES ('p1', 'web', '10.0.0.1', ?1)",
                [&group.id],
            )
            .unwrap();

        let error = service.delete(&group.id).unwrap_err();
        assert_eq!(error.code, "GROUP_NOT_EMPTY");
        assert_eq!(
            error.message,
            "该分组下仍有 1 台服务器，请先移动或删除后再删除分组"
        );
        assert!(service.get(&group.id).unwrap().is_some());
    }

    #[test]
    fn validation_and_missing_update_match_go_contract() {
        let (_directory, service) = service();
        let error = service
            .create(GroupCreateRequest {
                name: String::new(),
                parent_id: None,
                icon: None,
            })
            .unwrap_err();
        assert_eq!(error.code, "VALIDATION");
        assert_eq!(error.message, "name is required");

        let error = service
            .update(
                "missing",
                GroupUpdateRequest {
                    name: None,
                    parent_id: None,
                    icon: None,
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "DB_ERROR");
        service.delete("missing").unwrap();
    }
}
