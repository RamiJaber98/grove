//! Committing, amending, and undoing the last commit.

use std::path::Path;

use super::{run, run_with_stdin, GitError, GitResult};

/// Commits what's staged. The message goes through stdin so multi-line
/// messages and special characters survive intact. Hooks run as usual.
/// Returns the new commit's short hash.
pub fn commit(root: &Path, message: &str, amend: bool) -> GitResult<String> {
    let message = message.trim();
    let mut args = vec!["commit"];
    if amend {
        args.push("--amend");
    }
    if message.is_empty() {
        if !amend {
            return Err(GitError::new("Enter a commit message."));
        }
        args.push("--no-edit");
        run(root, &args)?;
    } else {
        args.extend(["-F", "-"]);
        run_with_stdin(root, &args, message.as_bytes())?;
    }
    Ok(run(root, &["rev-parse", "--short", "HEAD"])?.trim().to_string())
}

/// Full message of HEAD, or `None` when there are no commits yet.
pub fn last_message(root: &Path) -> GitResult<Option<String>> {
    if run(root, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
        return Ok(None);
    }
    Ok(Some(run(root, &["log", "-1", "--format=%B"])?.trim_end().to_string()))
}

/// Moves HEAD back one commit, keeping its changes staged. Returns the
/// undone commit's message so the UI can put it back in the message box.
pub fn undo_last(root: &Path) -> GitResult<String> {
    let message = last_message(root)?.ok_or_else(|| GitError::new("There are no commits to undo."))?;
    if run(root, &["rev-parse", "--verify", "-q", "HEAD~1"]).is_ok() {
        run(root, &["reset", "--soft", "HEAD~1"])?;
    } else {
        // Undoing the very first commit: remove the branch ref, keep the index.
        run(root, &["update-ref", "-d", "HEAD"])?;
    }
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::status::status;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "T"],
            &["config", "commit.gpgsign", "false"],
        ] {
            run(dir.path(), args).unwrap();
        }
        dir
    }

    #[test]
    fn commit_amend_undo() {
        let dir = repo();
        let root = dir.path();
        std::fs::write(root.join("a.txt"), "1").unwrap();
        run(root, &["add", "a.txt"]).unwrap();

        assert!(commit(root, "   ", false).is_err());
        let hash = commit(root, "First line\n\nBody with \"quotes\" & $vars", false).unwrap();
        assert!(!hash.is_empty());
        assert_eq!(
            last_message(root).unwrap().as_deref(),
            Some("First line\n\nBody with \"quotes\" & $vars")
        );

        commit(root, "Reworded", true).unwrap();
        assert_eq!(last_message(root).unwrap().as_deref(), Some("Reworded"));

        // Undoing the root commit keeps the file staged.
        assert_eq!(undo_last(root).unwrap(), "Reworded");
        let s = status(root).unwrap();
        assert!(!s.has_commits);
        assert_eq!(s.staged.len(), 1);
        assert!(undo_last(root).is_err());
    }
}
