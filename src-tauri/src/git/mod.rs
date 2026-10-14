//! Thin wrapper around the user's `git` executable. Every git operation in
//! Grove goes through `run`, so behaviour matches the terminal exactly
//! (credentials, hooks, config, SSH keys).

use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct GitError {
    pub message: String,
}

impl GitError {
    fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }
}

pub type GitResult<T> = Result<T, GitError>;

/// Runs `git <args>` in `cwd` and returns stdout, or stderr as the error.
pub fn run(cwd: &Path, args: &[&str]) -> GitResult<String> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        // Keep git from opening pagers or prompting on a terminal we don't have.
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");

    #[cfg(windows)]
    {
        // Don't flash a console window for every git invocation.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            GitError::new("git was not found on your PATH. Install git and restart Grove.")
        } else {
            GitError::new(format!("failed to run git: {e}"))
        }
    })?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(GitError::new(if stderr.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            stderr
        }))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Absolute path of the working tree root, with forward slashes.
    pub root: String,
    /// Folder name of the root, used for the window title.
    pub name: String,
    /// Current branch, or `None` when HEAD is detached.
    pub branch: Option<String>,
}

/// Resolves any path inside a working tree to the repository it belongs to.
pub fn repo_info(path: &Path) -> GitResult<RepoInfo> {
    if !path.is_dir() {
        return Err(GitError::new(format!("{} is not a folder", path.display())));
    }
    let root = run(path, &["rev-parse", "--show-toplevel"])
        .map_err(|_| GitError::new(format!("{} is not inside a git repository", path.display())))?
        .trim()
        .to_string();

    let name = root.rsplit('/').next().unwrap_or(&root).to_string();

    // Empty on a detached HEAD; also works on a fresh repo with no commits.
    let branch = run(Path::new(&root), &["branch", "--show-current"])?
        .trim()
        .to_string();

    Ok(RepoInfo {
        root,
        name,
        branch: (!branch.is_empty()).then_some(branch),
    })
}
