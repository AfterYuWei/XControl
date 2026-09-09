//! SSH connection profile feature.

mod connection;
mod error;
mod legacy;
mod model;
mod repository;
mod service;

pub(crate) use model::ProxyInput;
pub(crate) use model::{
    Profile, ProfileCreateRequest, ProfileUpdateRequest, ProxyConfig, ResolvedProfileNode,
};
pub(crate) use service::ProfileService;
