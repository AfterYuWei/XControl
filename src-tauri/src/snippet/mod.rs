//! Command snippet feature.

mod model;
mod repository;
mod service;

pub(crate) use model::{Snippet, SnippetCreateRequest, SnippetUpdateRequest};
pub(crate) use service::SnippetService;
