use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct AuditLog {
    pub id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub profile_id: String,
    pub action: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
    pub timestamp: String,
}
