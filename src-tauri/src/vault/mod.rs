//! Encrypted credential vault feature.

mod crypto;
mod error;
mod model;
mod repository;
mod service;

pub(crate) use crypto::Encryptor;
pub(crate) use error::VaultError;
pub(crate) use model::{
    Credential, GenerateKeyRequest, GenerateKeyResponse, ProfileRef, VaultItem, VaultWriteRequest,
};
pub(crate) use service::{decode_plaintext, encode_plaintext, generate_key_pair, VaultService};
