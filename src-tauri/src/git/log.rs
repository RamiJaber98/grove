//! Commit history for the History view, plus per-commit actions.

use std::path::Path;

use serde::Serialize;

use super::status::FileChange;
use super::{run, GitError, GitResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub hash: String,
    pub short: String,
    pub parents: Vec<String>,
    pub author: String,
    pub time: i64,
    /// Decorations like `HEAD -> main`, `origin/main`, `tag: v1.0`.
    pub refs: Vec<String>,
    pub subject: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub committer: String,
    pub commit_time: i64,
    pub message: String,
    /// Changes relative to the first parent (or everything, for a root commit).
    pub files: Vec<FileChange>,
}

const RS: char = '\u{1e}'; // record separator between commits

/// A page of history in topological order (so the graph draws cleanly).
/// `all` includes every branch and tag, not just HEAD's ancestry.
pub fn log(root: &Path, skip: usize, limit: usize, all: bool) -> GitResult<Vec<LogEntry>> {
    if run(root, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() && !all {
        return Ok(Vec::new());
    }
    let skip = format!("--skip={skip}");
    let limit = format!("-n{limit}");
    let mut args = vec![
        "log",
        "--topo-order",
        "--decorate=short",
        &skip,
        &limit,
        "--format=%x1e%H%x00%h%x00%P%x00%an%x00%at%x00%D%x00%s",
    ];
    if all {
        args.push("--all");
    }
    let out = match run(root, &args) {
        Ok(out) => out,
        // `--all` on a repo with no refs at all.
        Err(_) if all => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    Ok(out
        .split(RS)
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_end_matches('\n').splitn(7, '\0').collect();
            if f.len() < 7 {
                return None;
            }
            Some(LogEntry {
                hash: f[0].to_string(),
                short: f[1].to_string(),
                parents: f[2].split_whitespace().map(str::to_string).collect(),
                author: f[3].to_string(),
                time: f[4].parse().unwrap_or(0),
                refs: f[5].split(", ").filter(|r| !r.is_empty()).map(str::to_string).collect(),
                subject: f[6].to_string(),
            })
        })
        .collect())
}

/// Only full or abbreviated hex hashes are accepted as commit arguments.
pub(crate) fn check_hash(hash: &str) -> GitResult<&str> {
    if (4..=64).contains(&hash.len()) && hash.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(hash)
    } else {
        Err(GitError::new(format!("{hash} is not a commit hash")))
    }
}

pub fn detail(root: &Path, hash: &str) -> GitResult<CommitDetail> {
    let hash = check_hash(hash)?;
    let out = run(root, &["show", "-s", "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%B", hash])?;
    let f: Vec<&str> = out.splitn(8, '\0').collect();
    if f.len() < 8 {
        return Err(GitError::new(format!("could not read commit {hash}")));
    }
    let parents: Vec<String> = f[1].split_whitespace().map(str::to_string).collect();

    let names = match parents.first() {
        Some(first) => run(root, &["diff", "--name-status", "-z", "-M", first, f[0]])?,
        None => run(root, &["diff-tree", "--root", "--no-commit-id", "-r", "-z", "--name-status", "-M", f[0]])?,
    };
    let mut files = super::stash::parse_name_status(&names);
    files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(CommitDetail {
        hash: f[0].to_string(),
        parents,
        author: f[2].to_string(),
        email: f[3].to_string(),
        time: f[4].parse().unwrap_or(0),
        committer: f[5].to_string(),
        commit_time: f[6].parse().unwrap_or(0),
        message: f[7].trim_end().to_string(),
        files,
    })
}

fn is_merge(root: &Path, hash: &str) -> GitResult<bool> {
    let parents = run(root, &["show", "-s", "--format=%P", hash])?;
    Ok(parents.split_whitespace().count() > 1)
}

/// Applies `hash` on top of HEAD. Merge commits are picked relative to their
/// first parent (the branch they were merged into).
pub fn cherry_pick(root: &Path, hash: &str) -> GitResult<()> {
    let hash = check_hash(hash)?;
    let mut args = vec!["cherry-pick"];
    if is_merge(root, hash)? {
        args.extend(["-m", "1"]);
    }
    args.push(hash);
    run(root, &args).map(drop)
}

/// Adds a commit that undoes `hash`.
pub fn revert(root: &Path, hash: &str) -> GitResult<()> {
    let hash = check_hash(hash)?;
    let mut args = vec!["revert", "--no-edit"];
    if is_merge(root, hash)? {
        args.extend(["-m", "1"]);
    }
    args.push(hash);
    run(root, &args).map(drop)
}

/// Checks out a commit without a branch (detached HEAD).
pub fn checkout_detached(root: &Path, hash: &str) -> GitResult<()> {
    run(root, &["switch", "--detach", check_hash(hash)?]).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "Tess"],
            &["config", "commit.gpgsign", "false"],
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
    fn log_detail_cherry_pick_revert() {
        let dir = repo();
        let root = dir.path();
        assert!(log(root, 0, 10, false).unwrap().is_empty());

        commit_file(root, "a.txt", "1\n", "first");
        run(root, &["tag", "v1"]).unwrap();
        commit_file(root, "a.txt", "2\n", "second\n\nWith a body.");
        run(root, &["switch", "-qc", "side"]).unwrap();
        commit_file(root, "b.txt", "b\n", "side work");
        run(root, &["switch", "-q", "main"]).unwrap();

        let entries = log(root, 0, 10, false).unwrap();
        assert_eq!(entries.iter().map(|e| e.subject.as_str()).collect::<Vec<_>>(), ["second", "first"]);
        assert!(entries[0].refs.iter().any(|r| r == "HEAD -> main"));
        assert!(entries[1].refs.iter().any(|r| r == "tag: v1"));
        assert_eq!(entries[0].parents, vec![entries[1].hash.clone()]);
        assert_eq!(log(root, 0, 10, true).unwrap().len(), 3);
        assert_eq!(log(root, 1, 10, false).unwrap().len(), 1);

        let d = detail(root, &entries[0].hash).unwrap();
        assert_eq!(d.message, "second\n\nWith a body.");
        assert_eq!(d.author, "Tess");
        assert_eq!(d.files.len(), 1);
        let root_detail = detail(root, &entries[1].hash).unwrap();
        assert!(root_detail.parents.is_empty());
        assert_eq!(root_detail.files[0].kind, 'A');

        let side = log(root, 0, 10, true).unwrap().into_iter().find(|e| e.subject == "side work").unwrap();
        cherry_pick(root, &side.hash).unwrap();
        assert!(root.join("b.txt").exists());
        let head = log(root, 0, 1, false).unwrap().remove(0);
        revert(root, &head.hash).unwrap();
        assert!(!root.join("b.txt").exists());

        assert!(check_hash("--all").is_err());
        checkout_detached(root, &entries[1].hash).unwrap();
        assert_eq!(crate::git::status::status(root).unwrap().branch, None);
    }
}
