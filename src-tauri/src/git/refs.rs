//! Branches, tags, remotes, reset, clean and recent commits.
//!
//! Names typed by the user are validated before reaching git, and anything
//! starting with `-` is rejected so it can never be read as an option.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{run, GitError, GitResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// Short name: `main`, or `origin/main` for remote branches.
    pub name: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
    pub hash: String,
    pub subject: String,
    /// Unix seconds of the tip commit.
    pub time: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub name: String,
    pub subject: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub time: i64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

/// Rejects empty values and anything git could parse as an option.
fn plain_arg<'a>(what: &str, value: &'a str) -> GitResult<&'a str> {
    let value = value.trim();
    if value.is_empty() {
        return Err(GitError::new(format!("Enter a {what}.")));
    }
    if value.starts_with('-') {
        return Err(GitError::new(format!("A {what} can't start with \"-\".")));
    }
    Ok(value)
}

/// Uses git's own rules for branch names (no spaces, `..`, `~`, etc.).
pub fn check_branch_name(root: &Path, name: &str) -> GitResult<()> {
    let name = plain_arg("branch name", name)?;
    run(root, &["check-ref-format", "--branch", name])
        .map(drop)
        .map_err(|_| GitError::new(format!("\"{name}\" isn't a valid branch name.")))
}

fn check_tag_name(root: &Path, name: &str) -> GitResult<()> {
    let name = plain_arg("tag name", name)?;
    run(root, &["check-ref-format", &format!("refs/tags/{name}")])
        .map(drop)
        .map_err(|_| GitError::new(format!("\"{name}\" isn't a valid tag name.")))
}

pub fn branches(root: &Path) -> GitResult<Vec<Branch>> {
    let out = run(
        root,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(objectname:short)%00%(committerdate:unix)%00%(subject)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(7, '\0').collect();
            if f.len() < 7 || f[0].ends_with("/HEAD") {
                return None; // origin/HEAD is an alias, not a branch
            }
            Some(Branch {
                name: f[1].to_string(),
                remote: f[0].starts_with("refs/remotes/"),
                current: f[2] == "*",
                upstream: (!f[3].is_empty()).then(|| f[3].to_string()),
                hash: f[4].to_string(),
                time: f[5].parse().unwrap_or(0),
                subject: f[6].to_string(),
            })
        })
        .collect())
}

/// Switches to a local branch, or for a remote branch (`origin/feat`)
/// creates a local tracking branch `feat`, reusing it if it already exists.
pub fn checkout(root: &Path, name: &str, remote: bool) -> GitResult<String> {
    let name = plain_arg("branch", name)?;
    if !remote {
        run(root, &["switch", name])?;
        return Ok(name.to_string());
    }
    let local = name.split_once('/').map(|(_, b)| b).unwrap_or(name);
    let exists = run(root, &["rev-parse", "--verify", "-q", &format!("refs/heads/{local}")]).is_ok();
    if exists {
        run(root, &["switch", local])?;
    } else {
        run(root, &["switch", "--track", name])?;
    }
    Ok(local.to_string())
}

pub fn create_branch(root: &Path, name: &str, start: Option<&str>, switch: bool) -> GitResult<()> {
    check_branch_name(root, name)?;
    let name = name.trim();
    let mut args = if switch { vec!["switch", "-c", name] } else { vec!["branch", name] };
    if let Some(start) = start {
        args.push(plain_arg("start point", start)?);
    }
    run(root, &args).map(drop)
}

pub fn rename_branch(root: &Path, old: &str, new: &str) -> GitResult<()> {
    check_branch_name(root, new)?;
    run(root, &["branch", "-m", plain_arg("branch", old)?, new.trim()]).map(drop)
}

/// Without `force`, git refuses to delete a branch with unmerged commits;
/// that error is passed through so the UI can offer a forced delete.
pub fn delete_branch(root: &Path, name: &str, force: bool) -> GitResult<()> {
    let flag = if force { "-D" } else { "-d" };
    run(root, &["branch", flag, plain_arg("branch", name)?]).map(drop)
}

pub fn merge(root: &Path, name: &str) -> GitResult<String> {
    let out = run(root, &["merge", "--no-edit", plain_arg("branch", name)?])?;
    Ok(if out.contains("Already up to date") {
        "Already up to date.".to_string()
    } else if out.contains("Fast-forward") {
        format!("Fast-forwarded to {name}.")
    } else {
        format!("Merged {name}.")
    })
}

pub fn rebase(root: &Path, onto: &str) -> GitResult<String> {
    let out = run(root, &["rebase", plain_arg("branch", onto)?])?;
    Ok(if out.contains("is up to date") {
        "Already up to date.".to_string()
    } else {
        format!("Rebased onto {onto}.")
    })
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationAction {
    Abort,
    Continue,
}

/// Aborts or continues an in-progress merge, rebase, cherry-pick or revert.
pub fn operation(root: &Path, kind: &str, action: OperationAction) -> GitResult<()> {
    let cmd = match kind {
        "merge" | "rebase" | "cherry-pick" | "revert" => kind,
        _ => return Err(GitError::new(format!("unknown operation {kind}"))),
    };
    let action = match action {
        OperationAction::Abort => "--abort",
        OperationAction::Continue => "--continue",
    };
    // `--continue` may want an editor for the commit message; accept git's
    // prepared message instead of hanging on an editor nobody can see.
    run(root, &["-c", "core.editor=true", cmd, action]).map(drop)
}

pub fn tags(root: &Path) -> GitResult<Vec<Tag>> {
    let out = run(root, &["tag", "--list", "--sort=-creatordate", "--format=%(refname:short)%00%(subject)"])?;
    Ok(out
        .lines()
        .filter_map(|l| l.split_once('\0'))
        .map(|(name, subject)| Tag { name: name.to_string(), subject: subject.to_string() })
        .collect())
}

/// An annotated tag when `message` is non-empty, else a lightweight one.
/// Tags HEAD unless `target` names another commit.
pub fn create_tag(root: &Path, name: &str, message: &str, target: Option<&str>) -> GitResult<()> {
    check_tag_name(root, name)?;
    let name = name.trim();
    let message = message.trim();
    let mut args = if message.is_empty() { vec!["tag", name] } else { vec!["tag", "-a", name, "-m", message] };
    if let Some(target) = target {
        args.push(plain_arg("commit", target)?);
    }
    run(root, &args).map(drop)
}

pub fn delete_tag(root: &Path, name: &str) -> GitResult<()> {
    run(root, &["tag", "-d", plain_arg("tag", name)?]).map(drop)
}

pub fn remotes(root: &Path) -> GitResult<Vec<Remote>> {
    let out = run(root, &["remote", "-v"])?;
    let mut remotes: Vec<Remote> = Vec::new();
    for line in out.lines().filter(|l| l.ends_with("(fetch)")) {
        let mut parts = line.split_whitespace();
        if let (Some(name), Some(url)) = (parts.next(), parts.next()) {
            remotes.push(Remote { name: name.to_string(), url: url.to_string() });
        }
    }
    Ok(remotes)
}

pub fn add_remote(root: &Path, name: &str, url: &str) -> GitResult<()> {
    let name = plain_arg("remote name", name)?;
    let url = plain_arg("remote URL", url)?;
    run(root, &["remote", "add", name, url]).map(drop)
}

pub fn remove_remote(root: &Path, name: &str) -> GitResult<()> {
    run(root, &["remote", "remove", plain_arg("remote", name)?]).map(drop)
}

pub fn reset(root: &Path, target: &str, mode: ResetMode) -> GitResult<()> {
    let flag = match mode {
        ResetMode::Soft => "--soft",
        ResetMode::Mixed => "--mixed",
        ResetMode::Hard => "--hard",
    };
    run(root, &["reset", "-q", flag, plain_arg("commit", target)?]).map(drop)
}

/// Deletes untracked files and directories (not ignored ones). Returns how
/// many paths were removed.
pub fn clean(root: &Path) -> GitResult<usize> {
    let out = run(root, &["clean", "-f", "-d"])?;
    Ok(out.lines().filter(|l| l.starts_with("Removing ")).count())
}

pub fn recent_commits(root: &Path, limit: usize) -> GitResult<Vec<Commit>> {
    if run(root, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
        return Ok(Vec::new());
    }
    let limit = format!("-n{limit}");
    let out = run(root, &["log", &limit, "--format=%H%x00%h%x00%an%x00%ct%x00%s"])?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.splitn(5, '\0').collect();
            (f.len() == 5).then(|| Commit {
                hash: f[0].to_string(),
                short: f[1].to_string(),
                author: f[2].to_string(),
                time: f[3].parse().unwrap_or(0),
                subject: f[4].to_string(),
            })
        })
        .collect())
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
            &["config", "tag.gpgsign", "false"],
        ] {
            run(dir.path(), args).unwrap();
        }
        dir
    }

    fn commit_file(root: &Path, name: &str, content: &str, msg: &str) {
        std::fs::write(root.join(name), content).unwrap();
        run(root, &["add", name]).unwrap();
        run(root, &["commit", "-qm", msg]).unwrap();
    }

    #[test]
    fn branch_lifecycle_and_merge() {
        let dir = repo();
        let root = dir.path();
        commit_file(root, "a.txt", "1", "one");

        assert!(create_branch(root, "bad name", None, true).is_err());
        assert!(create_branch(root, "-x", None, true).is_err());
        create_branch(root, "feature", None, true).unwrap();
        assert_eq!(status(root).unwrap().branch.as_deref(), Some("feature"));
        commit_file(root, "b.txt", "2", "two");

        checkout(root, "main", false).unwrap();
        assert!(delete_branch(root, "feature", false).is_err(), "unmerged");
        assert_eq!(merge(root, "feature").unwrap(), "Fast-forwarded to feature.");
        rename_branch(root, "feature", "done").unwrap();
        delete_branch(root, "done", false).unwrap();

        let names: Vec<_> = branches(root).unwrap().into_iter().map(|b| (b.name, b.current)).collect();
        assert_eq!(names, vec![("main".to_string(), true)]);
    }

    #[test]
    fn merge_conflict_then_abort() {
        let dir = repo();
        let root = dir.path();
        commit_file(root, "a.txt", "base", "base");
        create_branch(root, "other", None, true).unwrap();
        commit_file(root, "a.txt", "theirs", "theirs");
        checkout(root, "main", false).unwrap();
        commit_file(root, "a.txt", "ours", "ours");

        assert!(merge(root, "other").is_err());
        let s = status(root).unwrap();
        assert_eq!(s.operation.as_deref(), Some("merge"));
        assert_eq!(s.conflicts.len(), 1);

        operation(root, "merge", OperationAction::Abort).unwrap();
        let s = status(root).unwrap();
        assert_eq!(s.operation, None);
        assert!(s.conflicts.is_empty());
    }

    #[test]
    fn tags_remotes_reset_clean() {
        let dir = repo();
        let root = dir.path();
        commit_file(root, "a.txt", "1", "one");
        commit_file(root, "a.txt", "2", "two");

        create_tag(root, "v1.0", "First release", None).unwrap();
        create_tag(root, "light", "", Some("HEAD~1")).unwrap();
        assert!(create_tag(root, "bad..tag", "", None).is_err());
        let t = tags(root).unwrap();
        assert!(t.iter().any(|t| t.name == "v1.0" && t.subject == "First release"));
        delete_tag(root, "light").unwrap();
        assert_eq!(tags(root).unwrap().len(), 1);

        add_remote(root, "origin", "https://example.com/repo.git").unwrap();
        assert!(add_remote(root, "-bad", "x").is_err());
        assert_eq!(remotes(root).unwrap()[0].url, "https://example.com/repo.git");
        remove_remote(root, "origin").unwrap();
        assert!(remotes(root).unwrap().is_empty());

        let commits = recent_commits(root, 10).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "two");
        reset(root, &commits[1].hash, ResetMode::Soft).unwrap();
        assert_eq!(status(root).unwrap().staged.len(), 1);
        reset(root, "HEAD", ResetMode::Hard).unwrap();
        assert!(status(root).unwrap().staged.is_empty());

        std::fs::create_dir(root.join("junk")).unwrap();
        std::fs::write(root.join("junk/x.tmp"), "x").unwrap();
        std::fs::write(root.join("y.tmp"), "y").unwrap();
        assert_eq!(clean(root).unwrap(), 2);
        assert!(!root.join("junk").exists());
    }
}
