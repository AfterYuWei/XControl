use serde::{Deserialize, Serialize};

/// 系统栏/刘海安全区内边距，单位为 CSS 像素（Android dp / iOS pt）。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInsets {
    pub top: f64,
    pub bottom: f64,
    pub left: f64,
    pub right: f64,
}
