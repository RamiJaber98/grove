//! Index and working-tree operations: stage, unstage, discard.
//!
//! Paths are repo-relative with forward slashes, exactly as `status` reports
//! them. They're passed over stdin with `--literal-pathspecs`, so names
//! containing `*`, `[` or spaces are never treated as globs.

use std::path::{Component, Path};

use super::{nul_paths, run, run_with_stdin, GitError, GitResult};

const PATHSPEC_STDIN: [&str; 2] = ["--pathspec-from-file=-", "--pathspec-file-nul"];

fn with_paths(root: &Path, args: &[&str], paths: &[String]) -> GitResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut full = vec!["--literal-pathspecs"];
    full.extend_from_slice(args);
    full.extend_from_slice(&PATHSPEC_STDIN);
    run_with_stdin(root, &full, &nul_paths(paths)).map(drop)
}

pub fn stage(root: &Path, paths: &[String]) -> GitResult<()> {
    // -A so deletions are staged too.
    with_paths(root, &["add", "-A"], paths)
}

/// Works on repos without commits too: reset then just drops the entries.
pub fn unstage(root: &Path, paths: &[String]) -> GitResult<()> {
    with_paths(root, &["reset", "-q"], paths)
}

pub fn unstage_all(root: &Path) -> GitResult<()> {
    run(root, &["reset", "-q"]).map(drop)
}

/// Reverts working-tree edits to tracked files (back to the staged version)
/// and deletes untracked files.
pub fn discard(root: &Path, tracked: &[String], untracked: &[String]) -> GitResult<()> {
    with_paths(root, &["restore", "--worktree"], tracked)?;
    for p in untracked {
        let rel = Path::new(p);
        // Never let a path escape the working tree.
        if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
            return Err(GitError::new(format!("refusing to delete {p}: not a repository path")));
        }
        let full = root.join(rel);
        if full.is_file() || full.is_symlink() {
            std::fs::remove_file(&full)
                .map_err(|e| GitError::new(format!("could not delete {p}: {e}")))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::status::status;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        run(dir.path(), &["init", "-q"]).unwrap();
        run(dir.path(), &["config", "user.email", "test@example.com"]).unwrap();
        run(dir.path(), &["config", "user.name", "Test"]).unwrap();
        run(dir.path(), &["config", "core.autocrlf", "false"]).unwrap();
        dir
    }

    fn paths(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn stage_unstage_discard_roundtrip() {
        let dir = repo();
        let root = dir.path();
        std::fs::write(root.join("tracked.txt"), "one\n").unwrap();
        stage(root, &paths(&["tracked.txt"])).unwrap();
        run(root, &["commit", "-qm", "init"]).unwrap();

        std::fs::write(root.join("tracked.txt"), "two\n").unwrap();
        std::fs::write(root.join("new [1].txt"), "new\n").unwrap();

        stage(root, &paths(&["new [1].txt"])).unwrap();
        let s = status(root).unwrap();
        assert_eq!(s.staged.len(), 1);
        assert_eq!(s.staged[0].path, "new [1].txt");
        assert_eq!(s.changes.len(), 1);

        unstage(root, &paths(&["new [1].txt"])).unwrap();
        let s = status(root).unwrap();
        assert!(s.staged.is_empty());
        assert_eq!(s.changes.len(), 2);

        discard(root, &paths(&["tracked.txt"]), &paths(&["new [1].txt"])).unwrap();
        let s = status(root).unwrap();
        assert!(s.changes.is_empty());
        assert_eq!(std::fs::read_to_string(root.join("tracked.txt")).unwrap(), "one\n");
        assert!(!root.join("new [1].txt").exists());
    }

    #[test]
    fn discard_rejects_escaping_paths() {
        let dir = repo();
        assert!(discard(dir.path(), &[], &paths(&["../outside.txt"])).is_err());
    }
}
