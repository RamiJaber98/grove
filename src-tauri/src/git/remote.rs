//! Network operations: fetch, pull, push, sync.
//!
//! These use whatever credentials git is configured with (Git Credential
//! Manager, macOS keychain, SSH agent). Terminal prompts are disabled, so a
//! missing credential fails with git's message instead of hanging.

use std::path::Path;

use serde::Deserialize;

use super::status::status;
use super::{run, GitError, GitResult};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteOp {
    Fetch,
    FetchPrune,
    FetchAll,
    Pull,
    PullRebase,
    Push,
    PushForce,
    PushTags,
    Sync,
}

/// Runs `op` and returns a one-line summary for the UI.
pub fn run_op(root: &Path, op: RemoteOp) -> GitResult<String> {
    match op {
        RemoteOp::Fetch => fetch(root, &["fetch"]),
        RemoteOp::FetchPrune => fetch(root, &["fetch", "--prune"]),
        RemoteOp::FetchAll => fetch(root, &["fetch", "--all", "--prune"]),
        RemoteOp::Pull => pull(root, false),
        RemoteOp::PullRebase => pull(root, true),
        RemoteOp::Push => push(root, false),
        RemoteOp::PushForce => push(root, true),
        RemoteOp::PushTags => {
            let remote = default_remote(root)?;
            run(root, &["push", &remote, "--tags"])?;
            Ok(format!("Pushed tags to {remote}."))
        }
        RemoteOp::Sync => {
            pull(root, false)?;
            push(root, false).map(|pushed| format!("Synced. {pushed}"))
        }
    }
}

fn fetch(root: &Path, args: &[&str]) -> GitResult<String> {
    require_remote(root)?;
    run(root, args)?;
    let s = status(root)?;
    Ok(match (&s.upstream, s.behind) {
        (Some(up), 0) => format!("Fetched. {} is up to date with {up}.", branch_name(&s.branch)),
        (Some(up), n) => format!("Fetched. {n} new commit{} on {up}.", plural(n)),
        (None, _) => "Fetched.".to_string(),
    })
}

fn pull(root: &Path, rebase: bool) -> GitResult<String> {
    let s = status(root)?;
    let branch = s
        .branch
        .ok_or_else(|| GitError::new("HEAD is detached. Check out a branch to pull."))?;
    let upstream = s.upstream.ok_or_else(|| {
        GitError::new(format!("{branch} has no upstream branch yet. Push it first to create one."))
    })?;
    let mut args = vec!["pull"];
    if rebase {
        args.push("--rebase");
    }
    let out = run(root, &args)?;
    Ok(if out.contains("Already up to date") {
        format!("{branch} is already up to date with {upstream}.")
    } else {
        format!("Pulled {upstream} into {branch}.")
    })
}

fn push(root: &Path, force: bool) -> GitResult<String> {
    let s = status(root)?;
    let branch = s
        .branch
        .ok_or_else(|| GitError::new("HEAD is detached. Check out a branch to push."))?;
    if !s.has_commits {
        return Err(GitError::new("There's nothing to push yet. Make a commit first."));
    }

    let mut args = vec!["push"];
    if force {
        // Refuses to overwrite commits on the remote that you haven't fetched.
        args.push("--force-with-lease");
    }
    match &s.upstream {
        Some(upstream) => {
            if s.ahead == 0 && !force {
                return Ok(format!("Nothing to push. {branch} is up to date with {upstream}."));
            }
            run(root, &args)?;
            Ok(format!("Pushed {} commit{} to {upstream}.", s.ahead, plural(s.ahead)))
        }
        None => {
            // First push of this branch: publish it and track the remote copy.
            let remote = default_remote(root)?;
            args.extend(["-u", &remote, &branch]);
            run(root, &args)?;
            Ok(format!("Published {branch} to {remote}/{branch}."))
        }
    }
}

fn remotes(root: &Path) -> GitResult<Vec<String>> {
    Ok(run(root, &["remote"])?.lines().map(str::to_string).collect())
}

fn require_remote(root: &Path) -> GitResult<()> {
    if remotes(root)?.is_empty() {
        return Err(GitError::new("This repository has no remotes. Add one first."));
    }
    Ok(())
}

/// `origin` if it exists, else the only remote. Several remotes and none
/// called origin is ambiguous, so ask the user to set an upstream.
fn default_remote(root: &Path) -> GitResult<String> {
    let all = remotes(root)?;
    if all.iter().any(|r| r == "origin") {
        return Ok("origin".into());
    }
    match all.as_slice() {
        [only] => Ok(only.clone()),
        [] => Err(GitError::new("This repository has no remotes. Add one first.")),
        _ => Err(GitError::new(format!(
            "There are several remotes ({}) and none is called origin. Set an upstream for this branch first.",
            all.join(", ")
        ))),
    }
}

fn branch_name(b: &Option<String>) -> &str {
    b.as_deref().unwrap_or("HEAD")
}

fn plural(n: u32) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init(dir: &Path, bare: bool) {
        let mut args = vec!["init", "-q", "-b", "main"];
        if bare {
            args.push("--bare");
        }
        run(dir, &args).unwrap();
    }

    fn configure(dir: &Path) {
        for args in [
            &["config", "user.email", "t@example.com"][..],
            &["config", "user.name", "T"],
            &["config", "commit.gpgsign", "false"],
        ] {
            run(dir, args).unwrap();
        }
    }

    #[test]
    fn publish_push_fetch_pull() {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin.git");
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        for d in [&origin, &a] {
            std::fs::create_dir(d).unwrap();
        }
        init(&origin, true);
        init(&a, false);
        configure(&a);

        // No remote yet.
        assert!(run_op(&a, RemoteOp::Fetch).is_err());
        run(&a, &["remote", "add", "origin", origin.to_str().unwrap()]).unwrap();
        assert!(run_op(&a, RemoteOp::Push).is_err(), "nothing to push before the first commit");

        std::fs::write(a.join("f.txt"), "1").unwrap();
        run(&a, &["add", "."]).unwrap();
        run(&a, &["commit", "-qm", "one"]).unwrap();
        let msg = run_op(&a, RemoteOp::Push).unwrap();
        assert!(msg.starts_with("Published main"), "{msg}");
        assert_eq!(status(&a).unwrap().upstream.as_deref(), Some("origin/main"));

        // A second clone pushes a commit; `a` fetches then pulls it.
        run(tmp.path(), &["clone", "-q", origin.to_str().unwrap(), "b"]).unwrap();
        configure(&b);
        std::fs::write(b.join("f.txt"), "2").unwrap();
        run(&b, &["commit", "-qam", "two"]).unwrap();
        assert!(run_op(&b, RemoteOp::Push).unwrap().starts_with("Pushed 1 commit to origin/main"));

        assert!(run_op(&a, RemoteOp::Fetch).unwrap().contains("1 new commit"));
        assert_eq!(run_op(&a, RemoteOp::Pull).unwrap(), "Pulled origin/main into main.");
        assert_eq!(std::fs::read_to_string(a.join("f.txt")).unwrap(), "2");
        assert!(run_op(&a, RemoteOp::Push).unwrap().starts_with("Nothing to push"));
    }
}
