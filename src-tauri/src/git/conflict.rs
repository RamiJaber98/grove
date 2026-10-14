//! Merge conflict resolution: everything the in-app conflict editor needs.
//!
//! A conflicted path has up to three index stages: 1 = merge base, 2 = "ours"
//! (HEAD), 3 = "theirs" (the commit being merged / picked / replayed). Which
//! stages exist tells us the kind of conflict (both modified, deleted by one
//! side, both added); the working file holds git's marker-annotated merge.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::diff::Side;
use super::{ops, repo_path, run, run_bytes, GitError, GitResult};

/// Files above this size aren't sent to the editor (same limit as diffs).
const MAX_BYTES: usize = 5 * 1024 * 1024;
/// Same heuristic git uses: a NUL byte near the start means binary.
const BINARY_SNIFF: usize = 8000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    /// Porcelain two-letter code: UU (both modified), AA (both added),
    /// DU (deleted by us), UD (deleted by them), AU / UA (added by one side),
    /// DD (both deleted).
    pub code: String,
    pub base: Side,
    pub ours: Side,
    pub theirs: Side,
    pub working: Side,
    /// False when the working file isn't valid UTF-8; editing it as text and
    /// writing it back would corrupt it.
    pub utf8: bool,
    pub context: ConflictContext,
}

/// What produced the conflict, so the UI can name the two sides. The
/// frontend turns this into "Current (main)" / "Incoming (feature)" labels.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictContext {
    /// "merge", "rebase", "cherry-pick", "revert", or None (e.g. stash apply).
    pub operation: Option<String>,
    /// What HEAD is: the branch name, or a short hash when detached.
    pub head: Option<String>,
    /// The other side: merged branch, picked/reverted commit, or for a
    /// rebase the commit being replayed.
    pub incoming: Option<String>,
    /// Rebase only: the branch being rebased (what the user thinks of as
    /// "their" branch, even though git calls it "theirs").
    pub rebase_branch: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Resolution {
    /// Take stage 2 as-is (or delete the file if "ours" deleted it).
    Ours,
    /// Take stage 3 as-is (or delete the file if "theirs" deleted it).
    Theirs,
    /// Remove the file from both the index and the working tree.
    Delete,
}

fn side_from_bytes(bytes: Vec<u8>) -> Side {
    let size = bytes.len();
    if size > MAX_BYTES {
        return Side { exists: true, too_large: true, size, ..Default::default() };
    }
    if bytes[..size.min(BINARY_SNIFF)].contains(&0) {
        return Side { exists: true, binary: true, size, ..Default::default() };
    }
    Side { exists: true, size, text: String::from_utf8_lossy(&bytes).into_owned(), ..Default::default() }
}

/// Which stages (1..=3) the index holds for `path`.
fn stages(root: &Path, path: &str) -> GitResult<[bool; 3]> {
    let out = run(root, &["--literal-pathspecs", "ls-files", "-u", "-z", "--", path])?;
    let mut present = [false; 3];
    // "<mode> <hash> <stage>\t<path>"
    for rec in out.split('\0') {
        let Some((meta, _)) = rec.split_once('\t') else { continue };
        if let Some(n) = meta.rsplit(' ').next().and_then(|s| s.parse::<usize>().ok()) {
            if (1..=3).contains(&n) {
                present[n - 1] = true;
            }
        }
    }
    Ok(present)
}

fn code(present: [bool; 3]) -> &'static str {
    match present {
        [true, true, true] => "UU",
        [false, true, true] => "AA",
        [true, false, true] => "DU",
        [true, true, false] => "UD",
        [false, true, false] => "AU",
        [false, false, true] => "UA",
        [true, false, false] => "DD",
        [false, false, false] => "",
    }
}

fn read_stage(root: &Path, n: u8, path: &str, exists: bool) -> Side {
    if !exists {
        return Side::default();
    }
    // --filters converts line endings like a checkout, so the stages line up
    // with the file on disk.
    match run_bytes(root, &["cat-file", "--filters", &format!(":{n}:{path}")]) {
        Ok(bytes) => side_from_bytes(bytes),
        Err(_) => Side::default(),
    }
}

pub fn read(root: &Path, path: &str) -> GitResult<ConflictFile> {
    let full = repo_path(root, path)?;
    let present = stages(root, path)?;
    if present == [false; 3] {
        return Err(GitError::new(format!("{path} is not in conflict")));
    }

    let (working, utf8) = if full.is_file() {
        let bytes = std::fs::read(&full).map_err(|e| GitError::new(format!("could not read {path}: {e}")))?;
        let utf8 = std::str::from_utf8(&bytes).is_ok();
        (side_from_bytes(bytes), utf8)
    } else {
        (Side::default(), true)
    };

    Ok(ConflictFile {
        code: code(present).to_string(),
        base: read_stage(root, 1, path, present[0]),
        ours: read_stage(root, 2, path, present[1]),
        theirs: read_stage(root, 3, path, present[2]),
        working,
        utf8,
        context: context(root)?,
    })
}

/// Reads a file from the git directory (via --git-path, so linked worktrees
/// work), or None if it doesn't exist.
fn git_file(root: &Path, name: &str) -> Option<String> {
    let rel = run(root, &["rev-parse", "--git-path", name]).ok()?;
    std::fs::read_to_string(root.join(rel.trim())).ok()
}

fn short_commit(root: &Path, rev: &str) -> Option<String> {
    run(root, &["log", "-1", "--format=%h %s", rev, "--"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// A branch name for a commit if one points near it, else its short hash.
fn describe(root: &Path, hash: &str) -> String {
    let name = run(root, &["name-rev", "--name-only", "--no-undefined", "--refs=refs/heads/*", "--refs=refs/remotes/*", hash])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if !name.is_empty() {
        return name;
    }
    run(root, &["rev-parse", "--short", hash]).map(|s| s.trim().to_string()).unwrap_or_else(|_| hash.to_string())
}

/// The first quoted name in a merge message: "Merge branch 'feature' into main".
fn merged_name(msg: &str) -> Option<String> {
    let first = msg.lines().next()?;
    let start = first.find('\'')? + 1;
    let len = first[start..].find('\'')?;
    Some(first[start..start + len].to_string()).filter(|s| !s.is_empty())
}

pub fn context(root: &Path) -> GitResult<ConflictContext> {
    let head = run(root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| run(root, &["rev-parse", "--short", "HEAD"]).ok().map(|s| s.trim().to_string()));

    // Same precedence as status::operation.
    for dir in ["rebase-merge", "rebase-apply"] {
        let Some(onto) = git_file(root, &format!("{dir}/onto")) else { continue };
        let branch = git_file(root, &format!("{dir}/head-name"))
            .map(|s| s.trim().trim_start_matches("refs/heads/").to_string())
            .filter(|s| !s.is_empty() && s != "detached HEAD");
        return Ok(ConflictContext {
            operation: Some("rebase".into()),
            // During a rebase HEAD is the upstream being built on.
            head: Some(describe(root, onto.trim())),
            incoming: short_commit(root, "REBASE_HEAD"),
            rebase_branch: branch,
        });
    }
    if git_file(root, "MERGE_HEAD").is_some() {
        let incoming = git_file(root, "MERGE_MSG")
            .and_then(|m| merged_name(&m))
            .or_else(|| run(root, &["rev-parse", "--short", "MERGE_HEAD"]).ok().map(|s| s.trim().to_string()));
        return Ok(ConflictContext { operation: Some("merge".into()), head, incoming, rebase_branch: None });
    }
    for (marker, op) in [("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert")] {
        if git_file(root, marker).is_some() {
            return Ok(ConflictContext {
                operation: Some(op.into()),
                head,
                incoming: short_commit(root, marker),
                rebase_branch: None,
            });
        }
    }
    Ok(ConflictContext { head, ..Default::default() })
}

/// Converts `content` to the line-ending style `existing` mostly uses, so
/// resolving a conflict in the editor doesn't rewrite every line of a CRLF
/// file (or vice versa). Files without line breaks leave `content` alone.
fn match_line_endings(content: &str, existing: &[u8]) -> String {
    let crlf = existing.windows(2).filter(|w| w == b"\r\n").count();
    let lf = existing.iter().filter(|&&b| b == b'\n').count() - crlf;
    if crlf == 0 && lf == 0 {
        return content.to_string();
    }
    let normalized = content.replace("\r\n", "\n");
    if crlf > lf {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    }
}

/// Writes the editor's resolved text over the working file, then stages it
/// (marking the conflict resolved) when `stage` is set. Whether markers are
/// left is the UI's call: it warns and lets the user override.
pub fn save(root: &Path, path: &str, content: &str, stage: bool) -> GitResult<()> {
    let full = repo_path(root, path)?;
    let existing = std::fs::read(&full).unwrap_or_default();
    let text = match_line_endings(content, &existing);
    std::fs::write(&full, text).map_err(|e| GitError::new(format!("could not write {path}: {e}")))?;
    if stage {
        ops::stage(root, &[path.to_string()])?;
    }
    Ok(())
}

/// Resolves a whole file at once (binary files, delete-vs-modify) and stages
/// the result.
pub fn resolve(root: &Path, path: &str, resolution: Resolution) -> GitResult<()> {
    repo_path(root, path)?;
    let present = stages(root, path)?;
    let (flag, exists) = match resolution {
        Resolution::Ours => ("--ours", present[1]),
        Resolution::Theirs => ("--theirs", present[2]),
        Resolution::Delete => ("", false),
    };
    if exists {
        run(root, &["--literal-pathspecs", "checkout", flag, "--", path])?;
        ops::stage(root, &[path.to_string()])
    } else {
        // The chosen side deleted the file (or the user asked to): taking it
        // means removing the path. --cached copes with an already-missing
        // working file; the file itself is removed separately.
        run(root, &["--literal-pathspecs", "rm", "-q", "--cached", "--", path])?;
        let full = repo_path(root, path)?;
        if full.is_file() || full.is_symlink() {
            std::fs::remove_file(&full).map_err(|e| GitError::new(format!("could not delete {path}: {e}")))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::status::status;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "T"],
            &["config", "commit.gpgsign", "false"],
            &["config", "core.autocrlf", "false"],
            &["config", "merge.conflictstyle", "merge"],
        ] {
            run(dir.path(), args).unwrap();
        }
        dir
    }

    fn write(root: &Path, name: &str, content: &[u8]) {
        std::fs::write(root.join(name), content).unwrap();
    }

    fn commit_all(root: &Path, msg: &str) {
        run(root, &["add", "-A"]).unwrap();
        run(root, &["commit", "-qm", msg]).unwrap();
    }

    /// main and `feature` both change a.txt, then main merges feature,
    /// leaving it conflicted.
    fn conflicted(base: &str, ours: &str, theirs: &str) -> tempfile::TempDir {
        let dir = repo();
        let root = dir.path();
        write(root, "a.txt", base.as_bytes());
        commit_all(root, "base");
        run(root, &["checkout", "-q", "-b", "feature"]).unwrap();
        write(root, "a.txt", theirs.as_bytes());
        commit_all(root, "theirs");
        run(root, &["checkout", "-q", "main"]).unwrap();
        write(root, "a.txt", ours.as_bytes());
        commit_all(root, "ours");
        assert!(run(root, &["merge", "--no-edit", "feature"]).is_err());
        dir
    }

    #[test]
    fn reads_stages_and_context() {
        let dir = conflicted("one\n", "ours\n", "theirs\n");
        let root = dir.path();
        let f = read(root, "a.txt").unwrap();
        assert_eq!(f.code, "UU");
        assert_eq!(f.base.text, "one\n");
        assert_eq!(f.ours.text, "ours\n");
        assert_eq!(f.theirs.text, "theirs\n");
        assert!(f.utf8);
        assert!(f.working.text.starts_with("<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature"));
        assert_eq!(
            f.context,
            ConflictContext {
                operation: Some("merge".into()),
                head: Some("main".into()),
                incoming: Some("feature".into()),
                rebase_branch: None,
            }
        );
        assert!(read(root, "../x.txt").is_err());
    }

    #[test]
    fn save_preserves_crlf_and_stages() {
        let dir = conflicted("one\r\n", "ours\r\n", "theirs\r\n");
        let root = dir.path();
        // The editor hands back LF text; the file was CRLF.
        save(root, "a.txt", "resolved\nline two\n", false).unwrap();
        assert_eq!(std::fs::read(root.join("a.txt")).unwrap(), b"resolved\r\nline two\r\n");
        assert_eq!(status(root).unwrap().conflicts.len(), 1);

        save(root, "a.txt", "resolved\r\n", true).unwrap();
        let s = status(root).unwrap();
        assert!(s.conflicts.is_empty());
        assert_eq!(s.staged.len(), 1);
        assert!(read(root, "a.txt").is_err());
    }

    #[test]
    fn line_endings_follow_existing_file() {
        assert_eq!(match_line_endings("a\r\nb\n", b"x\ny\n"), "a\nb\n");
        assert_eq!(match_line_endings("a\nb", b"x\r\ny\r\n"), "a\r\nb");
        assert_eq!(match_line_endings("a\r\nb\n", b"no newline"), "a\r\nb\n");
    }

    #[test]
    fn take_ours_and_theirs() {
        let dir = conflicted("one\n", "ours\n", "theirs\n");
        let root = dir.path();
        resolve(root, "a.txt", Resolution::Theirs).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "theirs\n");
        assert!(status(root).unwrap().conflicts.is_empty());

        // Binary files go through the same path.
        let dir = repo();
        let root = dir.path();
        write(root, "b.bin", b"\x00base");
        commit_all(root, "base");
        run(root, &["checkout", "-q", "-b", "feature"]).unwrap();
        write(root, "b.bin", b"\x00theirs");
        commit_all(root, "theirs");
        run(root, &["checkout", "-q", "main"]).unwrap();
        write(root, "b.bin", b"\x00ours");
        commit_all(root, "ours");
        assert!(run(root, &["merge", "--no-edit", "feature"]).is_err());
        let f = read(root, "b.bin").unwrap();
        assert!(f.ours.binary && f.theirs.binary);
        resolve(root, "b.bin", Resolution::Ours).unwrap();
        assert_eq!(std::fs::read(root.join("b.bin")).unwrap(), b"\x00ours");
        assert!(status(root).unwrap().conflicts.is_empty());
    }

    #[test]
    fn delete_vs_modify() {
        // main deletes a.txt, feature modifies it: "deleted by us".
        let dir = repo();
        let root = dir.path();
        write(root, "a.txt", b"one\n");
        write(root, "keep.txt", b"k\n");
        commit_all(root, "base");
        run(root, &["checkout", "-q", "-b", "feature"]).unwrap();
        write(root, "a.txt", b"changed\n");
        commit_all(root, "modify");
        run(root, &["checkout", "-q", "main"]).unwrap();
        run(root, &["rm", "-q", "a.txt"]).unwrap();
        run(root, &["commit", "-qm", "delete"]).unwrap();
        assert!(run(root, &["merge", "--no-edit", "feature"]).is_err());

        let f = read(root, "a.txt").unwrap();
        assert_eq!(f.code, "DU");
        assert!(!f.ours.exists);
        assert_eq!(f.theirs.text, "changed\n");

        // Taking "ours" means accepting the deletion.
        resolve(root, "a.txt", Resolution::Ours).unwrap();
        assert!(!root.join("a.txt").exists());
        let s = status(root).unwrap();
        assert!(s.conflicts.is_empty());
        assert!(s.staged.is_empty() && s.changes.is_empty());

        // Redo the merge and keep the modified file instead.
        run(root, &["merge", "--abort"]).unwrap();
        assert!(run(root, &["merge", "--no-edit", "feature"]).is_err());
        resolve(root, "a.txt", Resolution::Theirs).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "changed\n");
        let s = status(root).unwrap();
        assert!(s.conflicts.is_empty());
        assert_eq!(s.staged.len(), 1);

        // Explicit delete.
        run(root, &["merge", "--abort"]).unwrap();
        assert!(run(root, &["merge", "--no-edit", "feature"]).is_err());
        resolve(root, "a.txt", Resolution::Delete).unwrap();
        assert!(!root.join("a.txt").exists());
        assert!(status(root).unwrap().conflicts.is_empty());
    }

    #[test]
    fn rebase_context_names_both_branches() {
        let dir = repo();
        let root = dir.path();
        write(root, "a.txt", b"one\n");
        commit_all(root, "base");
        run(root, &["checkout", "-q", "-b", "feature"]).unwrap();
        write(root, "a.txt", b"mine\n");
        commit_all(root, "my change");
        run(root, &["checkout", "-q", "main"]).unwrap();
        write(root, "a.txt", b"upstream\n");
        commit_all(root, "upstream change");
        run(root, &["checkout", "-q", "feature"]).unwrap();
        assert!(run(root, &["rebase", "main"]).is_err());

        let f = read(root, "a.txt").unwrap();
        // "ours" is the upstream during a rebase.
        assert_eq!(f.ours.text, "upstream\n");
        assert_eq!(f.theirs.text, "mine\n");
        assert_eq!(f.context.operation.as_deref(), Some("rebase"));
        assert_eq!(f.context.head.as_deref(), Some("main"));
        assert_eq!(f.context.rebase_branch.as_deref(), Some("feature"));
        assert!(f.context.incoming.as_deref().unwrap().ends_with("my change"));
    }

    #[test]
    fn merged_name_parses_messages() {
        assert_eq!(merged_name("Merge branch 'feature' into main\n").as_deref(), Some("feature"));
        assert_eq!(merged_name("Merge remote-tracking branch 'origin/x'").as_deref(), Some("origin/x"));
        assert_eq!(merged_name("Merge something"), None);
    }
}
