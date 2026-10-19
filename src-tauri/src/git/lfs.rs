//! Git LFS awareness. Grove never requires LFS: when it isn't installed,
//! pointers are simply recognised and described instead of diffed as text.

use std::path::Path;

use serde::Serialize;

use super::stream::Op;
use super::{run, GitError, GitResult};

/// Pointer files are tiny; anything bigger is real content.
const MAX_POINTER: usize = 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct LfsPointer {
    pub oid: String,
    /// Size of the real file in bytes.
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsInfo {
    /// `git lfs` runs.
    pub installed: bool,
    /// The repository's .gitattributes routes files through LFS.
    pub used: bool,
}

/// Recognises an LFS pointer (https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md).
pub fn parse_pointer(bytes: &[u8]) -> Option<LfsPointer> {
    if bytes.len() > MAX_POINTER {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.lines();
    if !lines.next()?.starts_with("version https://git-lfs.github.com/spec/") {
        return None;
    }
    let (mut oid, mut size) = (None, None);
    for line in lines {
        if let Some(v) = line.strip_prefix("oid ") {
            oid = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("size ") {
            size = v.trim().parse().ok();
        }
    }
    Some(LfsPointer { oid: oid?, size: size? })
}

pub fn installed(root: &Path) -> bool {
    run(root, &["lfs", "version"]).is_ok()
}

/// Only the top-level .gitattributes is checked; that's where `git lfs
/// track` writes.
pub fn used(root: &Path) -> bool {
    std::fs::read_to_string(root.join(".gitattributes")).is_ok_and(|a| a.contains("filter=lfs"))
}

pub fn info(root: &Path) -> LfsInfo {
    let used = used(root);
    // Only pay for spawning `git lfs` when it matters.
    LfsInfo { installed: used && installed(root), used }
}

/// Downloads LFS objects for the current checkout and replaces pointers in
/// the working tree with the real files.
pub fn pull(root: &Path, net: &Op) -> GitResult<String> {
    if !installed(root) {
        return Err(GitError::new("Git LFS isn't installed. Install it from https://git-lfs.com and try again."));
    }
    net.run_plain(root, &["lfs", "pull"])?;
    Ok("Fetched LFS objects.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_pointers() {
        let p = b"version https://git-lfs.github.com/spec/v1\noid sha256:abc123\nsize 2048\n";
        assert_eq!(parse_pointer(p), Some(LfsPointer { oid: "sha256:abc123".into(), size: 2048 }));
        assert_eq!(parse_pointer(b"version https://git-lfs.github.com/spec/v1\nsize 1\n"), None);
        assert_eq!(parse_pointer(b"hello\n"), None);
        assert_eq!(parse_pointer(b"\x89PNG\x00"), None);
        let mut big = p.to_vec();
        big.extend(std::iter::repeat_n(b'x', 2000));
        assert_eq!(parse_pointer(&big), None);
    }

    #[test]
    fn detects_lfs_usage() {
        let dir = tempfile::tempdir().unwrap();
        run(dir.path(), &["init", "-q"]).unwrap();
        assert!(!used(dir.path()));
        assert!(!info(dir.path()).installed, "not checked when unused");
        std::fs::write(dir.path().join(".gitattributes"), "*.psd filter=lfs diff=lfs merge=lfs -text\n").unwrap();
        assert!(used(dir.path()));
        // Whether `installed` is true depends on the machine; it must not error either way.
        let _ = info(dir.path());
    }
}
