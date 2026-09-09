use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Snippet {
    pub id: String,
    pub name: String,
    pub content: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub tags: Vec<String>,
    pub is_global: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SnippetCreateRequest {
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub is_global: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SnippetUpdateRequest {
    pub name: Option<String>,
    pub content: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
    pub is_global: Option<bool>,
}
