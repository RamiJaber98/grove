//! The two versions of a file that the diff viewer compares. Grove sends
//! whole files to Monaco rather than a patch, so it can show full context and
//! switch between side-by-side and inline views without asking git again.

use std::path::Path;

use serde::Serialize;

use super::{repo_path, run_bytes, GitError, GitResult};

/// Files above this size aren't sent to the editor.
const MAX_BYTES: usize = 5 * 1024 * 1024;
/// Same heuristic git uses: a NUL byte near the start means binary.
const BINARY_SNIFF: usize = 8000;

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    /// False when the file doesn't exist on this side (added / deleted).
    pub exists: bool,
    pub binary: bool,
    pub too_large: bool,
    /// Byte size of the content, even when it isn't sent.
    pub size: usize,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersions {
    pub original: Side,
    pub modified: Side,
}

/// Where one side of a diff comes from.
pub(crate) enum Source<'a> {
    /// `<rev>:<path>` from the object database.
    Rev(&'a str, &'a str),
    /// The staged copy (`:<n>:<path>`); stage 2 is "ours" during a merge.
    Index(u8, &'a str),
    /// The file on disk.
    Worktree(&'a str),
}

impl Side {
    fn missing() -> Self {
        Self::default()
    }

    fn from_bytes(bytes: Vec<u8>) -> Self {
        let size = bytes.len();
        if size > MAX_BYTES {
            return Self { exists: true, too_large: true, size, ..Default::default() };
        }
        if bytes[..size.min(BINARY_SNIFF)].contains(&0) {
            return Self { exists: true, binary: true, size, ..Default::default() };
        }
        Self {
            exists: true,
            size,
            text: String::from_utf8_lossy(&bytes).into_owned(),
            ..Default::default()
        }
    }
}

fn read(root: &Path, source: Source) -> GitResult<Side> {
    Ok(match read_raw(root, source, MAX_BYTES)? {
        Raw::Missing => Side::missing(),
        Raw::TooLarge(size) => Side { exists: true, too_large: true, size, ..Default::default() },
        Raw::Bytes(bytes) => Side::from_bytes(bytes),
    })
}

/// One side's undecoded bytes, shared with viewers that don't want text
/// (image diffs).
pub(crate) enum Raw {
    Missing,
    TooLarge(usize),
    Bytes(Vec<u8>),
}

/// Reads one side as bytes, refusing anything over `max` bytes.
pub(crate) fn read_raw(root: &Path, source: Source, max: usize) -> GitResult<Raw> {
    let spec = match source {
        Source::Worktree(path) => {
            let full = repo_path(root, path)?;
            if !full.is_file() {
                return Ok(Raw::Missing);
            }
            let size = full.metadata().map(|m| m.len() as usize).unwrap_or(0);
            if size > max {
                return Ok(Raw::TooLarge(size));
            }
            let bytes = std::fs::read(&full)
                .map_err(|e| GitError::new(format!("could not read {path}: {e}")))?;
            return Ok(Raw::Bytes(bytes));
        }
        Source::Rev(rev, path) => format!("{rev}:{path}"),
        Source::Index(0, path) => format!(":{path}"),
        Source::Index(n, path) => format!(":{n}:{path}"),
    };
    // --filters applies the same line-ending and smudge conversion as a
    // checkout, so the staged copy lines up with the file on disk. A failure
    // here means the object doesn't exist on this side (new file, no commits
    // yet, etc.).
    match run_bytes(root, &["cat-file", "--filters", &spec]) {
        Ok(bytes) if bytes.len() > max => Ok(Raw::TooLarge(bytes.len())),
        Ok(bytes) => Ok(Raw::Bytes(bytes)),
        Err(_) => Ok(Raw::Missing),
    }
}

/// `group` is where the file was selected: a panel group, or "commit" for
/// the History view. `rev` names the stash or commit for those two.
pub fn versions(
    root: &Path,
    group: &str,
    path: &str,
    from: Option<&str>,
    rev: Option<&str>,
) -> GitResult<FileVersions> {
    let (original, modified) = match group {
        // HEAD → index. For renames the HEAD side is the old path.
        "staged" => (
            read(root, Source::Rev("HEAD", from.unwrap_or(path)))?,
            read(root, Source::Index(0, path))?,
        ),
        // index → disk. Untracked files have no index side, so all lines are new.
        "changes" => (read(root, Source::Index(0, path))?, read(root, Source::Worktree(path))?),
        // ours → disk (with conflict markers).
        "conflicts" => (read(root, Source::Index(2, path))?, read(root, Source::Worktree(path))?),
        // stash parent → stash. Untracked files live in the stash's third parent.
        // first parent → commit. A root commit has no parent side.
        "commit" => {
            let commit = rev.ok_or_else(|| GitError::new("missing commit"))?;
            if !commit.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(GitError::new(format!("{commit} is not a commit hash")));
            }
            let parent = format!("{commit}^1");
            (read(root, Source::Rev(&parent, from.unwrap_or(path)))?, read(root, Source::Rev(commit, path))?)
        }
        "stash" => {
            let stash = rev.ok_or_else(|| GitError::new("missing stash reference"))?;
            let parent = format!("{stash}^1");
            let mut modified = read(root, Source::Rev(stash, path))?;
            if !modified.exists {
                let untracked = format!("{stash}^3");
                modified = read(root, Source::Rev(&untracked, path))?;
            }
            (read(root, Source::Rev(&parent, from.unwrap_or(path)))?, modified)
        }
        other => return Err(GitError::new(format!("unknown group {other}"))),
    };
    Ok(FileVersions { original, modified })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::run;

    #[test]
    fn reads_each_side() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "T"],
            &["config", "core.autocrlf", "false"],
        ] {
            run(root, args).unwrap();
        }
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        run(root, &["add", "a.txt"]).unwrap();
        run(root, &["commit", "-qm", "init"]).unwrap();

        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        run(root, &["add", "a.txt"]).unwrap();
        std::fs::write(root.join("a.txt"), "three\n").unwrap();
        std::fs::write(root.join("new.txt"), "fresh\n").unwrap();
        std::fs::write(root.join("bin.dat"), b"\x00\x01\x02").unwrap();

        let v = versions(root, "staged", "a.txt", None, None).unwrap();
        assert_eq!((v.original.text.as_str(), v.modified.text.as_str()), ("one\n", "two\n"));

        let v = versions(root, "changes", "a.txt", None, None).unwrap();
        assert_eq!((v.original.text.as_str(), v.modified.text.as_str()), ("two\n", "three\n"));

        let v = versions(root, "changes", "new.txt", None, None).unwrap();
        assert!(!v.original.exists);
        assert_eq!(v.modified.text, "fresh\n");

        let v = versions(root, "changes", "bin.dat", None, None).unwrap();
        assert!(v.modified.binary && v.modified.text.is_empty());

        // Stash with an untracked file: tracked change in the stash commit,
        // untracked file in its third parent.
        run(root, &["stash", "push", "-u", "-q"]).unwrap();
        let v = versions(root, "stash", "a.txt", None, Some("stash@{0}")).unwrap();
        assert_eq!((v.original.text.as_str(), v.modified.text.as_str()), ("one\n", "three\n"));
        let v = versions(root, "stash", "new.txt", None, Some("stash@{0}")).unwrap();
        assert!(!v.original.exists);
        assert_eq!(v.modified.text, "fresh\n");

        assert!(versions(root, "changes", "../escape.txt", None, None).is_err());
    }
}
