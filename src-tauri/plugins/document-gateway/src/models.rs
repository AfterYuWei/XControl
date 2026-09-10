use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickRequest {
    pub staging_dir: String,
    pub multiple: bool,
    pub mime_types: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDocument {
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickResponse {
    pub documents: Vec<NativeDocument>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub source_path: String,
    pub suggested_name: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResponse {
    pub saved: bool,
    pub destination: Option<String>,
}
