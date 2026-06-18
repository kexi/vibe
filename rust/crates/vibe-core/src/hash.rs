//! SHA-256 hashing for the trust mechanism.
//!
//! Ported from `packages/core/src/utils/hash.ts`. The trust store records the
//! lowercase hex SHA-256 of `.vibe.toml`/`.vibe.local.toml`; this module
//! reproduces that exact digest (64 hex chars, zero-padded) so existing trust
//! records keep verifying after the Rust migration.

use crate::error::{Result, VibeError};
use sha2::{Digest, Sha256};
use std::path::Path;

/// Calculate the SHA-256 of arbitrary content as a 64-char lowercase hex string.
pub fn hash_content(content: &[u8]) -> String {
    let digest = Sha256::digest(content);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        // Matches the TS `toString(16).padStart(2, "0")` per byte.
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Calculate the SHA-256 of a file's contents.
pub fn hash_file(path: impl AsRef<Path>) -> Result<String> {
    let path = path.as_ref();
    let content = std::fs::read(path).map_err(|e| {
        VibeError::FileSystem(format!("Failed to read \"{}\": {e}", path.display()))
    })?;
    Ok(hash_content(&content))
}

/// Verify that a file's hash matches `expected`.
pub fn verify_file_hash(path: impl AsRef<Path>, expected: &str) -> Result<bool> {
    Ok(hash_file(path)? == expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_empty_content_to_known_digest() {
        // SHA-256 of the empty string.
        assert_eq!(
            hash_content(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn hashes_abc_to_known_digest() {
        assert_eq!(
            hash_content(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn digest_is_64_lowercase_hex_chars() {
        let h = hash_content(b"vibe");
        assert_eq!(h.len(), 64);
        assert!(h
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }
}
