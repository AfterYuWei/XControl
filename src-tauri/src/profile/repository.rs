use rusqlite::{params, params_from_iter, OptionalExtension, Row};

use crate::{error::CommandError, infrastructure::database::Database, vault::ProfileRef};

use super::{connection::parse_proxy_options, Profile};

#[derive(Clone)]
pub(super) struct ProfileRepository {
    pub(super) database: Database,
}

impl ProfileRepository {
    pub(super) fn new(database: Database) -> Self {
        Self { database }
    }

    pub(super) fn list(
        &self,
        group_id: Option<&str>,
        search: Option<&str>,
    ) -> Result<Vec<Profile>, CommandError> {
        let connection = self.database.connect()?;
        let mut query = format!("{} WHERE 1=1", profile_select());
        let mut arguments = Vec::<String>::new();
        if let Some(group_id) = group_id.filter(|value| !value.is_empty()) {
            query.push_str(" AND group_id=?");
            arguments.push(group_id.to_owned());
        }
        if let Some(search) = search.filter(|value| !value.is_empty()) {
            query.push_str(" AND (name LIKE ? OR host LIKE ? OR note LIKE ?)");
            let pattern = format!("%{search}%");
            arguments.extend([pattern.clone(), pattern.clone(), pattern]);
        }
        query.push_str(" ORDER BY sort_order, name");
        let mut statement = connection.prepare(&query).map_err(CommandError::database)?;
        let rows = statement
            .query_map(params_from_iter(arguments.iter()), profile_from_row)
            .map_err(CommandError::database)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(CommandError::database)
    }

    pub(super) fn get(&self, id: &str) -> Result<Option<Profile>, CommandError> {
        self.database
            .connect()?
            .query_row(
                &format!("{} WHERE id=?1", profile_select()),
                [id],
                profile_from_row,
            )
            .optional()
            .map_err(CommandError::database)
    }

    pub(super) fn insert(&self, profile: &Profile) -> Result<(), CommandError> {
        let tags = serde_json::to_string(&profile.tags).unwrap_or_else(|_| "[]".into());
        self.database
            .connect()?
            .execute(
                "INSERT INTO profiles \
                 (id,name,host,port,username,auth_type,icon,vault_id,inline_credential,\
                  proxy_credential,group_id,tags,options,note,sort_order,created_at,updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
                params![
                    profile.id,
                    profile.name,
                    profile.host,
                    profile.port,
                    profile.username,
                    profile.auth_type,
                    profile.icon,
                    profile.vault_id,
                    profile.inline_credential,
                    profile.proxy_credential,
                    profile.group_id,
                    tags,
                    profile.options,
                    profile.note,
                    profile.sort_order,
                    profile.created_at,
                    profile.updated_at,
                ],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub(super) fn update(&self, profile: &Profile) -> Result<(), CommandError> {
        let tags = serde_json::to_string(&profile.tags).unwrap_or_else(|_| "[]".into());
        self.database
            .connect()?
            .execute(
                "UPDATE profiles SET name=?1,host=?2,port=?3,username=?4,auth_type=?5,icon=?6,\
                 vault_id=?7,inline_credential=?8,proxy_credential=?9,group_id=?10,tags=?11,\
                 options=?12,note=?13,updated_at=?14 WHERE id=?15",
                params![
                    profile.name,
                    profile.host,
                    profile.port,
                    profile.username,
                    profile.auth_type,
                    profile.icon,
                    profile.vault_id,
                    profile.inline_credential,
                    profile.proxy_credential,
                    profile.group_id,
                    tags,
                    profile.options,
                    profile.note,
                    profile.updated_at,
                    profile.id,
                ],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub(super) fn update_options(
        &self,
        profile_id: &str,
        options: &str,
        updated_at: &str,
    ) -> Result<(), CommandError> {
        self.database
            .connect()?
            .execute(
                "UPDATE profiles SET options=?1,updated_at=?2 WHERE id=?3",
                params![options, updated_at, profile_id],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub(super) fn update_last_used(
        &self,
        profile_id: &str,
        timestamp: &str,
    ) -> Result<(), CommandError> {
        self.database
            .connect()?
            .execute(
                "UPDATE profiles SET last_used_at=?1 WHERE id=?2",
                params![timestamp, profile_id],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub(super) fn delete(&self, profile_id: &str) -> Result<Vec<ProfileRef>, CommandError> {
        let mut connection = self.database.connect()?;
        let transaction = connection.transaction().map_err(CommandError::database)?;
        let mut statement = transaction
            .prepare("SELECT id,name,COALESCE(options,'{}') FROM profiles ORDER BY sort_order,name")
            .map_err(CommandError::database)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(CommandError::database)?;
        let mut references = Vec::new();
        for row in rows {
            let (id, name, options) = row.map_err(CommandError::database)?;
            let proxy = parse_proxy_options(&options);
            if proxy.proxy_type == "jump" && proxy.jump_profile_id == profile_id {
                references.push(ProfileRef { id, name });
            }
        }
        drop(statement);
        if references.is_empty() {
            transaction
                .execute("DELETE FROM profiles WHERE id=?1", [profile_id])
                .map_err(CommandError::database)?;
            transaction.commit().map_err(CommandError::database)?;
        }
        Ok(references)
    }
}

fn profile_select() -> &'static str {
    "SELECT id,name,host,port,username,auth_type,COALESCE(icon,''),COALESCE(vault_id,''),\
     COALESCE(inline_credential,''),COALESCE(proxy_credential,''),COALESCE(group_id,''),\
     COALESCE(tags,'[]'),COALESCE(options,'{}'),COALESCE(note,''),COALESCE(sort_order,0),\
     last_used_at,created_at,updated_at FROM profiles"
}

fn profile_from_row(row: &Row<'_>) -> rusqlite::Result<Profile> {
    let tags_json: String = row.get(11)?;
    let tags = serde_json::from_str(&tags_json).unwrap_or_default();
    let options: String = row.get(12)?;
    let proxy_credential: String = row.get(9)?;
    let mut proxy = parse_proxy_options(&options);
    proxy.has_password = !proxy_credential.is_empty();
    Ok(Profile {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        port: row.get(3)?,
        username: row.get(4)?,
        auth_type: row.get(5)?,
        icon: row.get(6)?,
        vault_id: row.get(7)?,
        inline_credential: row.get(8)?,
        proxy_credential,
        proxy,
        group_id: row.get(10)?,
        tags,
        options,
        note: row.get(13)?,
        sort_order: row.get(14)?,
        last_used_at: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}
