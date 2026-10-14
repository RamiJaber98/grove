//! Stash list (with each stash's files), and stash/apply/pop/drop.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::status::FileChange;
use super::{run, GitError, GitResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// e.g. `stash@{0}`.
    pub r#ref: String,
    /// The user's message, or git's "WIP on…" summary when none was given.
    pub message: String,
    /// Branch the stash was made on, when git recorded it.
    pub branch: Option<String>,
    /// Unix seconds.
    pub time: i64,
    pub files: Vec<FileChange>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StashMode {
    /// Staged and unstaged changes to tracked files.
    Tracked,
    /// Also untracked files.
    IncludeUntracked,
    /// Only what's staged.
    Staged,
}

pub fn list(root: &Path) -> GitResult<Vec<StashEntry>> {
    let out = run(root, &["stash", "list", "--format=%gd%x00%gs%x00%ct"])?;
    out.lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let mut parts = line.split('\0');
            let r#ref = parts.next().unwrap_or_default().to_string();
            let (branch, message) = split_subject(parts.next().unwrap_or_default());
            let time = parts.next().and_then(|t| t.parse().ok()).unwrap_or(0);
            let files = files(root, &r#ref)?;
            Ok(StashEntry { r#ref, message, branch, time, files })
        })
        .collect()
}

/// git records stash subjects as `On <branch>: <message>` or
/// `WIP on <branch>: <hash> <commit subject>`.
fn split_subject(subject: &str) -> (Option<String>, String) {
    for prefix in ["On ", "WIP on "] {
        if let Some(rest) = subject.strip_prefix(prefix) {
            if let Some((branch, msg)) = rest.split_once(": ") {
                let msg = if prefix == "WIP on " { format!("WIP: {msg}") } else { msg.to_string() };
                return (Some(branch.to_string()), msg);
            }
        }
    }
    (None, subject.to_string())
}

/// Files in a stash: tracked changes (stash vs. its base commit) plus any
/// untracked files, which git keeps in the stash's third parent.
fn files(root: &Path, r#ref: &str) -> GitResult<Vec<FileChange>> {
    let base = format!("{ref}^1");
    let out = run(root, &["diff", "--name-status", "-z", "-M", &base, r#ref])?;
    let mut files = parse_name_status(&out);

    let untracked = format!("{ref}^3");
    if run(root, &["rev-parse", "--verify", "-q", &untracked]).is_ok() {
        let out = run(root, &["ls-tree", "-r", "--name-only", "-z", &untracked])?;
        files.extend(out.split('\0').filter(|p| !p.is_empty()).map(|p| FileChange {
            path: p.to_string(),
            kind: 'U',
            from: None,
        }));
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// Parses `git diff --name-status -z`: `X\0path\0`, or `R<score>\0old\0new\0`
/// for renames and copies.
pub(super) fn parse_name_status(out: &str) -> Vec<FileChange> {
    let mut fields = out.split('\0').filter(|f| !f.is_empty());
    let mut files = Vec::new();
    while let Some(status) = fields.next() {
        let kind = match status.chars().next() {
            Some('M' | 'T') => 'M',
            Some(k @ ('A' | 'D' | 'R' | 'C')) => k,
            _ => 'M',
        };
        let first = fields.next().unwrap_or_default();
        let change = if matches!(kind, 'R' | 'C') {
            let to = fields.next().unwrap_or_default();
            FileChange { path: to.to_string(), kind, from: Some(first.to_string()) }
        } else {
            FileChange { path: first.to_string(), kind, from: None }
        };
        files.push(change);
    }
    files
}

pub fn push(root: &Path, message: &str, mode: StashMode) -> GitResult<()> {
    let mut args = vec!["stash", "push"];
    match mode {
        StashMode::Tracked => {}
        StashMode::IncludeUntracked => args.push("--include-untracked"),
        StashMode::Staged => args.push("--staged"),
    }
    let message = message.trim();
    if !message.is_empty() {
        args.extend(["-m", message]);
    }
    let out = run(root, &args)?;
    // git exits 0 even when there was nothing to stash.
    if out.contains("No local changes to save") {
        return Err(GitError::new("There are no changes to stash."));
    }
    Ok(())
}

pub fn apply(root: &Path, r#ref: &str, pop: bool) -> GitResult<()> {
    check_ref(r#ref)?;
    run(root, &["stash", if pop { "pop" } else { "apply" }, r#ref]).map(drop)
}

pub fn drop_stash(root: &Path, r#ref: &str) -> GitResult<()> {
    check_ref(r#ref)?;
    run(root, &["stash", "drop", r#ref]).map(drop)
}

/// Only accept `stash@{N}`, so a crafted ref can't become a git option.
fn check_ref(r#ref: &str) -> GitResult<()> {
    let ok = r#ref
        .strip_prefix("stash@{")
        .and_then(|r| r.strip_suffix('}'))
        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
    if ok {
        Ok(())
    } else {
        Err(GitError::new(format!("{ref} is not a stash")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::status::status;

    #[test]
    fn parses_subjects_and_name_status() {
        assert_eq!(split_subject("On main: my work"), (Some("main".into()), "my work".into()));
        assert_eq!(
            split_subject("WIP on feat/x: abc123 Add thing"),
            (Some("feat/x".into()), "WIP: abc123 Add thing".into())
        );
        let files = parse_name_status("M\0a.txt\0R087\0old.txt\0new.txt\0D\0gone.txt\0");
        assert_eq!(files.len(), 3);
        assert_eq!(files[1].path, "new.txt");
        assert_eq!(files[1].from.as_deref(), Some("old.txt"));
        assert!(check_ref("stash@{12}").is_ok());
        assert!(check_ref("--exec=x").is_err());
        assert!(check_ref("stash@{}").is_err());
    }

    #[test]
    fn stash_roundtrip() {
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
        std::fs::write(root.join("a.txt"), "1").unwrap();
        run(root, &["add", "."]).unwrap();
        run(root, &["commit", "-qm", "init"]).unwrap();

        assert!(push(root, "", StashMode::Tracked).is_err(), "nothing to stash");

        std::fs::write(root.join("a.txt"), "2").unwrap();
        std::fs::write(root.join("new.txt"), "n").unwrap();
        push(root, "both files", StashMode::IncludeUntracked).unwrap();
        assert!(status(root).unwrap().changes.is_empty());

        let stashes = list(root).unwrap();
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].r#ref, "stash@{0}");
        assert_eq!(stashes[0].message, "both files");
        let kinds: Vec<_> = stashes[0].files.iter().map(|f| (f.path.as_str(), f.kind)).collect();
        assert_eq!(kinds, vec![("a.txt", 'M'), ("new.txt", 'U')]);

        apply(root, "stash@{0}", false).unwrap();
        assert_eq!(list(root).unwrap().len(), 1, "apply keeps the stash");
        run(root, &["checkout", "--", "a.txt"]).unwrap();
        std::fs::remove_file(root.join("new.txt")).unwrap();

        apply(root, "stash@{0}", true).unwrap();
        assert!(list(root).unwrap().is_empty(), "pop removes it");
        assert_eq!(status(root).unwrap().changes.len(), 2);

        push(root, "", StashMode::Tracked).unwrap();
        drop_stash(root, "stash@{0}").unwrap();
        assert!(list(root).unwrap().is_empty());
    }
}
