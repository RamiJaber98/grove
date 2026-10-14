//! Branch operations that involve a remote: deleting a branch on the
//! remote, publishing to a chosen remote, and setting the upstream.

use std::path::Path;

use super::refs::{check_branch_name, plain_arg};
use super::status::status;
use super::{run, GitError, GitResult};

fn remote_names(root: &Path) -> GitResult<Vec<String>> {
    Ok(run(root, &["remote"])?.lines().map(str::to_string).collect())
}

fn check_remote(root: &Path, remote: &str) -> GitResult<String> {
    let remote = plain_arg("remote", remote)?;
    if !remote_names(root)?.iter().any(|r| r == remote) {
        return Err(GitError::new(format!("There's no remote called {remote}.")));
    }
    Ok(remote.to_string())
}

/// Splits `origin/feature/x` into (`origin`, `feature/x`). Remote names may
/// themselves contain `/`, so the longest matching remote wins.
fn split_remote_branch(root: &Path, name: &str) -> GitResult<(String, String)> {
    let name = plain_arg("remote branch", name)?;
    let remotes = remote_names(root)?;
    let remote = remotes
        .iter()
        .filter(|r| name.len() > r.len() + 1 && name.starts_with(r.as_str()) && name.as_bytes()[r.len()] == b'/')
        .max_by_key(|r| r.len())
        .ok_or_else(|| GitError::new(format!("{name} isn't a remote branch.")))?;
    let branch = &name[remote.len() + 1..];
    check_branch_name(root, branch)?;
    Ok((remote.clone(), branch.to_string()))
}

/// `git push <remote> --delete <branch>`, then drops the remote-tracking
/// ref. If the branch was already gone on the remote, only the stale
/// tracking ref is removed.
pub fn delete_remote_branch(root: &Path, name: &str) -> GitResult<String> {
    let (remote, branch) = split_remote_branch(root, name)?;
    let pushed = run(root, &["push", &remote, "--delete", &branch]);
    // Push usually removes the tracking ref itself; this covers the rest.
    let _ = run(root, &["branch", "-r", "-d", &format!("{remote}/{branch}")]);
    match pushed {
        Ok(_) => Ok(format!("Deleted {branch} on {remote}.")),
        Err(e) if e.message.contains("remote ref does not exist") => {
            Ok(format!("{branch} was already gone from {remote}; removed the stale {remote}/{branch}."))
        }
        Err(e) => Err(e),
    }
}

/// Pushes the current branch to `remote` and tracks it there.
pub fn publish_branch(root: &Path, remote: &str) -> GitResult<String> {
    let remote = check_remote(root, remote)?;
    let s = status(root)?;
    let branch = s.branch.ok_or_else(|| GitError::new("HEAD is detached. Check out a branch to publish."))?;
    if !s.has_commits {
        return Err(GitError::new("There's nothing to push yet. Make a commit first."));
    }
    run(root, &["push", "-u", &remote, &branch])?;
    Ok(format!("Published {branch} to {remote}/{branch}."))
}

/// Makes the current branch track `upstream` (a remote branch like
/// `origin/main`).
pub fn set_upstream(root: &Path, upstream: &str) -> GitResult<String> {
    let (remote, branch) = split_remote_branch(root, upstream)?;
    let upstream = format!("{remote}/{branch}");
    let current = status(root)?
        .branch
        .ok_or_else(|| GitError::new("HEAD is detached. Check out a branch first."))?;
    if run(root, &["rev-parse", "--verify", "-q", &format!("refs/remotes/{upstream}")]).is_err() {
        return Err(GitError::new(format!("{upstream} doesn't exist. Fetch first?")));
    }
    run(root, &["branch", &format!("--set-upstream-to={upstream}"), &current])?;
    Ok(format!("{current} now tracks {upstream}."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::refs::branches;

    fn configure(dir: &Path) {
        for args in [
            &["config", "user.email", "t@example.com"][..],
            &["config", "user.name", "T"],
            &["config", "commit.gpgsign", "false"],
        ] {
            run(dir, args).unwrap();
        }
    }

    fn remote_branches(root: &Path) -> Vec<String> {
        branches(root).unwrap().into_iter().filter(|b| b.remote).map(|b| b.name).collect()
    }

    #[test]
    fn publish_upstream_and_delete_remote_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let (origin, backup, work) = (tmp.path().join("origin.git"), tmp.path().join("backup.git"), tmp.path().join("w"));
        for d in [&origin, &backup, &work] {
            std::fs::create_dir(d).unwrap();
        }
        run(&origin, &["init", "-q", "--bare", "-b", "main"]).unwrap();
        run(&backup, &["init", "-q", "--bare", "-b", "main"]).unwrap();
        run(&work, &["init", "-q", "-b", "main"]).unwrap();
        configure(&work);
        run(&work, &["remote", "add", "origin", origin.to_str().unwrap()]).unwrap();
        run(&work, &["remote", "add", "backup", backup.to_str().unwrap()]).unwrap();
        run(&work, &["commit", "--allow-empty", "-qm", "one"]).unwrap();

        assert!(publish_branch(&work, "nowhere").is_err());
        assert!(publish_branch(&work, "--all").is_err());
        assert_eq!(publish_branch(&work, "backup").unwrap(), "Published main to backup/main.");
        assert_eq!(status(&work).unwrap().upstream.as_deref(), Some("backup/main"));

        run(&work, &["push", "-q", "origin", "main", "main:feature/x"]).unwrap();
        assert_eq!(set_upstream(&work, "origin/main").unwrap(), "main now tracks origin/main.");
        assert_eq!(status(&work).unwrap().upstream.as_deref(), Some("origin/main"));
        assert!(set_upstream(&work, "origin/missing").is_err());
        assert!(set_upstream(&work, "nowhere/main").is_err());

        assert!(delete_remote_branch(&work, "origin").is_err());
        assert!(delete_remote_branch(&work, "-origin/x").is_err());
        assert!(remote_branches(&work).contains(&"origin/feature/x".to_string()));
        assert_eq!(delete_remote_branch(&work, "origin/feature/x").unwrap(), "Deleted feature/x on origin.");
        assert!(!remote_branches(&work).contains(&"origin/feature/x".to_string()));
        assert!(run(&origin, &["rev-parse", "--verify", "-q", "refs/heads/feature/x"]).is_err());

        // Deleted elsewhere: the stale tracking ref still gets cleaned up.
        run(&work, &["push", "-q", "origin", "main:gone"]).unwrap();
        run(&origin, &["branch", "-D", "gone"]).unwrap();
        assert!(delete_remote_branch(&work, "origin/gone").unwrap().contains("already gone"));
        assert!(!remote_branches(&work).contains(&"origin/gone".to_string()));
    }
}
