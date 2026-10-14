//! Image diffs. Both sides are sent as base64 so the webview can show them
//! in `<img>` tags (SVG included: rendering it as an image keeps its scripts
//! and markup out of the DOM).

use std::path::Path;

use serde::Serialize;

use super::diff::{read_raw, Raw, Source};
use super::{lfs, GitError, GitResult};

/// Each side is capped so a huge texture can't stall the IPC bridge.
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSide {
    pub exists: bool,
    pub too_large: bool,
    pub size: usize,
    pub mime: String,
    /// Base64 of the file, empty when it isn't sent.
    pub data: String,
    /// Set when this side is a Git LFS pointer whose content isn't available
    /// locally: the real file's size.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lfs_size: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageVersions {
    pub original: ImageSide,
    pub modified: ImageSide,
}

/// The MIME type for an image extension the diff viewer can render.
pub fn mime_for(path: &str) -> Option<&'static str> {
    let ext = path.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

fn side(root: &Path, source: Source, mime: &str) -> GitResult<ImageSide> {
    let mime = mime.to_string();
    Ok(match read_raw(root, source, MAX_IMAGE_BYTES)? {
        Raw::Missing => ImageSide::default(),
        Raw::TooLarge(size) => ImageSide { exists: true, too_large: true, size, mime, ..Default::default() },
        Raw::Bytes(bytes) => match lfs::parse_pointer(&bytes) {
            Some(pointer) => ImageSide {
                exists: true,
                size: bytes.len(),
                mime,
                lfs_size: Some(pointer.size),
                ..Default::default()
            },
            None => ImageSide { exists: true, size: bytes.len(), data: base64(&bytes), mime, ..Default::default() },
        },
    })
}

/// Same sides as `diff::versions` (see there for what each group compares).
pub fn versions(
    root: &Path,
    group: &str,
    path: &str,
    from: Option<&str>,
    rev: Option<&str>,
) -> GitResult<ImageVersions> {
    let mime = mime_for(path).ok_or_else(|| GitError::new(format!("{path} is not a supported image")))?;
    let old = from.unwrap_or(path);
    let (original, modified) = match group {
        "staged" => (side(root, Source::Rev("HEAD", old), mime)?, side(root, Source::Index(0, path), mime)?),
        "changes" => (side(root, Source::Index(0, path), mime)?, side(root, Source::Worktree(path), mime)?),
        "conflicts" => (side(root, Source::Index(2, path), mime)?, side(root, Source::Worktree(path), mime)?),
        "commit" => {
            let commit = rev.ok_or_else(|| GitError::new("missing commit"))?;
            if !commit.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(GitError::new(format!("{commit} is not a commit hash")));
            }
            let parent = format!("{commit}^1");
            (side(root, Source::Rev(&parent, old), mime)?, side(root, Source::Rev(commit, path), mime)?)
        }
        "stash" => {
            let stash = rev.ok_or_else(|| GitError::new("missing stash reference"))?;
            let parent = format!("{stash}^1");
            let mut modified = side(root, Source::Rev(stash, path), mime)?;
            if !modified.exists {
                let untracked = format!("{stash}^3");
                modified = side(root, Source::Rev(&untracked, path), mime)?;
            }
            (side(root, Source::Rev(&parent, old), mime)?, modified)
        }
        other => return Err(GitError::new(format!("unknown group {other}"))),
    };
    Ok(ImageVersions { original, modified })
}

/// Standard base64 with padding (small enough not to need a crate).
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::run;

    #[test]
    fn encodes_base64() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
    }

    #[test]
    fn mime_types() {
        assert_eq!(mime_for("a/b/Logo.PNG"), Some("image/png"));
        assert_eq!(mime_for("x.svg"), Some("image/svg+xml"));
        assert_eq!(mime_for("x.txt"), None);
        assert_eq!(mime_for("png"), None);
    }

    #[test]
    fn reads_image_blobs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "T"],
            &["config", "commit.gpgsign", "false"],
        ] {
            run(root, args).unwrap();
        }
        // A PNG signature with NUL bytes in it: must round-trip untouched.
        let v1: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00one";
        let v2: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00two!";
        std::fs::write(root.join("pic.png"), v1).unwrap();
        run(root, &["add", "pic.png"]).unwrap();
        run(root, &["commit", "-qm", "add"]).unwrap();
        std::fs::write(root.join("pic.png"), v2).unwrap();

        let v = versions(root, "changes", "pic.png", None, None).unwrap();
        assert_eq!(v.original.data, base64(v1));
        assert_eq!(v.modified.data, base64(v2));
        assert_eq!((v.original.size, v.modified.size), (v1.len(), v2.len()));
        assert_eq!(v.modified.mime, "image/png");

        run(root, &["commit", "-qam", "change"]).unwrap();
        let head = run(root, &["rev-parse", "HEAD"]).unwrap();
        let v = versions(root, "commit", "pic.png", None, Some(head.trim())).unwrap();
        assert_eq!((v.original.data.as_str(), v.modified.data.as_str()), (base64(v1).as_str(), base64(v2).as_str()));

        // An LFS pointer committed without its content is reported, not sent.
        let pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";
        std::fs::write(root.join("big.png"), pointer).unwrap();
        let v = versions(root, "changes", "big.png", None, None).unwrap();
        assert!(!v.original.exists);
        assert_eq!(v.modified.lfs_size, Some(12345));
        assert!(v.modified.data.is_empty());

        assert!(versions(root, "changes", "notes.txt", None, None).is_err());
        assert!(versions(root, "commit", "pic.png", None, Some("HEAD;x")).is_err());
    }
}
