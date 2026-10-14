//! Thin wrapper around the user's `git` executable. Every git operation in
//! Grove goes through `run`/`run_with_stdin`, so behaviour matches the
//! terminal exactly (credentials, hooks, config, SSH keys).

pub mod blame;
pub mod commit;
pub mod conflict;
pub mod compare;
pub mod diff;
pub mod file_log;
pub mod files;
pub mod log;
pub mod ops;
pub mod rebase;
pub mod patch;
pub mod refs;
pub mod remote;
pub mod repo;
pub mod search;
pub mod stash;
pub mod status;
// Credential prompts, progress & cancel: streaming runner for network ops.
pub mod stream;

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct GitError {
    pub message: String,
}

impl GitError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }
}

pub type GitResult<T> = Result<T, GitError>;

fn command(cwd: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        // Keep git from opening pagers or prompting on a terminal we don't have.
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        // Stop `git status` from rewriting the index; otherwise every refresh
        // would trigger the file watcher and refresh again.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C");

    #[cfg(windows)]
    {
        // Don't flash a console window for every git invocation.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn spawn_error(e: std::io::Error) -> GitError {
    if e.kind() == std::io::ErrorKind::NotFound {
        GitError::new("git was not found on your PATH. Install git and restart Grove.")
    } else {
        GitError::new(format!("failed to run git: {e}"))
    }
}

fn finish(args: &[&str], output: std::process::Output) -> GitResult<String> {
    finish_bytes(args, output).map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn finish_bytes(args: &[&str], output: std::process::Output) -> GitResult<Vec<u8>> {
    if output.status.success() {
        Ok(output.stdout)
    } else {
        // Some failures only explain themselves on stdout ("nothing to
        // commit", merge CONFLICT lines), so fall back to it.
        let message = [&output.stderr, &output.stdout]
            .into_iter()
            .map(|b| clean_message(&String::from_utf8_lossy(b)))
            .find(|m| !m.is_empty())
            .unwrap_or_else(|| format!("git {} failed", args.join(" ")));
        Err(GitError::new(message))
    }
}

/// Drops git's `hint:` advice lines, which are written for terminal users.
fn clean_message(text: &str) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.starts_with("hint:")).collect();
    lines.join("
").trim().to_string()
}

/// Runs `git <args>` in `cwd` and returns stdout, or stderr as the error.
pub fn run(cwd: &Path, args: &[&str]) -> GitResult<String> {
    let output = command(cwd, args)
        .stdin(Stdio::null())
        .output()
        .map_err(spawn_error)?;
    finish(args, output)
}

/// Like `run`, but returns raw stdout (file contents may not be UTF-8).
pub fn run_bytes(cwd: &Path, args: &[&str]) -> GitResult<Vec<u8>> {
    let output = command(cwd, args)
        .stdin(Stdio::null())
        .output()
        .map_err(spawn_error)?;
    finish_bytes(args, output)
}

/// Like `run`, but writes `input` to git's stdin. Used with
/// `--pathspec-from-file=- --pathspec-file-nul` so any number of paths can be
/// passed without hitting command-line length limits.
pub fn run_with_stdin(cwd: &Path, args: &[&str], input: &[u8]) -> GitResult<String> {
    let mut child = command(cwd, args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_error)?;
    // Drop stdin after writing so git sees EOF.
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(input)
        .map_err(|e| GitError::new(format!("failed to write to git: {e}")))?;
    let output = child.wait_with_output().map_err(spawn_error)?;
    finish(args, output)
}

/// Like `run`, with extra environment variables. Interactive rebase uses it
/// to replace git's editors for that one invocation.
pub fn run_env(cwd: &Path, args: &[&str], envs: &[(&str, &str)]) -> GitResult<String> {
    let output = command(cwd, args)
        .envs(envs.iter().copied())
        .stdin(Stdio::null())
        .output()
        .map_err(spawn_error)?;
    finish(args, output)
}

/// NUL-joins paths for `--pathspec-file-nul`.
pub fn nul_paths(paths: &[String]) -> Vec<u8> {
    let mut buf = Vec::new();
    for p in paths {
        buf.extend_from_slice(p.as_bytes());
        buf.push(0);
    }
    buf
}

/// Joins a repo-relative path onto `root`, refusing anything that could
/// escape the working tree (`..`, absolute paths, drive prefixes).
pub fn repo_path(root: &Path, rel: &str) -> GitResult<PathBuf> {
    let rel_path = Path::new(rel);
    if rel.is_empty() || !rel_path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(GitError::new(format!("{rel} is not a path inside the repository")));
    }
    Ok(root.join(rel_path))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Absolute path of the working tree root, with forward slashes.
    pub root: String,
    /// Folder name of the root, used for the window title.
    pub name: String,
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
    Ok(RepoInfo { root, name })
}
