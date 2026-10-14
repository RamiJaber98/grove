//! Linked worktrees (`git worktree`): several checkouts of one repository.

use std::path::Path;

use serde::Serialize;

use super::refs::{check_branch_name, plain_arg};
use super::{run, GitError, GitResult};

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// Absolute path, as git prints it (forward slashes).
    pub path: String,
    pub head: Option<String>,
    /// Short branch name; None when detached or bare.
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    /// Its folder is gone; `git worktree prune` would remove it.
    pub prunable: bool,
    /// The first entry is the main worktree, which can't be removed.
    pub main: bool,
    /// The worktree this window has open.
    pub current: bool,
}

pub fn list(root: &Path) -> GitResult<Vec<Worktree>> {
    let out = run(root, &["worktree", "list", "--porcelain", "-z"])?;
    let mut list = parse(&out);
    let here = std::fs::canonicalize(root).ok();
    for w in &mut list {
        w.current = here.is_some() && std::fs::canonicalize(&w.path).ok() == here;
    }
    Ok(list)
}

/// `--porcelain -z`: attribute lines end in NUL, an empty one ends a record.
fn parse(out: &str) -> Vec<Worktree> {
    let mut list = Vec::new();
    let mut cur: Option<Worktree> = None;
    for line in out.split('\0') {
        if line.is_empty() {
            list.extend(cur.take());
            continue;
        }
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        if key == "worktree" {
            list.extend(cur.take());
            cur = Some(Worktree { path: value.to_string(), ..Default::default() });
            continue;
        }
        let Some(w) = cur.as_mut() else { continue };
        match key {
            "HEAD" => w.head = Some(value.to_string()),
            "branch" => w.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_string()),
            "bare" => w.bare = true,
            "detached" => w.detached = true,
            "locked" => w.locked = true,
            "prunable" => w.prunable = true,
            _ => {}
        }
    }
    list.extend(cur);
    if let Some(first) = list.first_mut() {
        first.main = true;
    }
    list
}

/// Checks `branch` out in a new worktree at `path`. With `create`, a new
/// branch is made from HEAD; otherwise it must be an existing local branch
/// not checked out elsewhere (git enforces that).
pub fn add(root: &Path, path: &str, branch: &str, create: bool) -> GitResult<()> {
    let path = plain_arg("folder", path)?;
    check_branch_name(root, branch)?;
    let branch = branch.trim();
    if Path::new(path).exists() && std::fs::read_dir(path).is_ok_and(|mut d| d.next().is_some()) {
        return Err(GitError::new(format!("{path} already exists and isn't empty.")));
    }
    if create {
        run(root, &["worktree", "add", "-b", branch, path]).map(drop)
    } else {
        run(root, &["worktree", "add", path, branch]).map(drop)
    }
}

/// Without `force`, git refuses when the worktree has uncommitted changes;
/// that error is passed through so the UI can offer a forced remove.
pub fn remove(root: &Path, path: &str, force: bool) -> GitResult<()> {
    let path = plain_arg("worktree", path)?;
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    run(root, &args).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain() {
        let out = "worktree /r\0HEAD abc\0branch refs/heads/main\0\0worktree /r-feat\0HEAD def\0detached\0locked reason\0\0worktree /gone\0HEAD 123\0branch refs/heads/x/y\0prunable gitdir file points to non-existent location\0\0";
        let w = parse(out);
        assert_eq!(w.len(), 3);
        assert!(w[0].main && !w[1].main);
        assert_eq!(w[0].branch.as_deref(), Some("main"));
        assert!(w[1].detached && w[1].locked && w[1].branch.is_none());
        assert_eq!(w[2].branch.as_deref(), Some("x/y"));
        assert!(w[2].prunable);
    }

    #[test]
    fn list_add_remove() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main");
        std::fs::create_dir(&main).unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "T"],
            &["config", "commit.gpgsign", "false"],
        ] {
            run(&main, args).unwrap();
        }
        run(&main, &["commit", "--allow-empty", "-qm", "one"]).unwrap();
        run(&main, &["branch", "existing"]).unwrap();

        let w = list(&main).unwrap();
        assert_eq!(w.len(), 1);
        assert!(w[0].main && w[0].current);

        let feat = tmp.path().join("feat").to_string_lossy().replace('\\', "/");
        let other = tmp.path().join("other").to_string_lossy().replace('\\', "/");
        add(&main, &feat, "feature", true).unwrap();
        add(&main, &other, "existing", false).unwrap();
        assert!(add(&main, &tmp.path().join("x").to_string_lossy(), "bad name", true).is_err());
        assert!(add(&main, "-f", "y", true).is_err());
        assert!(add(&main, &feat, "z", true).is_err(), "non-empty folder");

        let w = list(&main).unwrap();
        let branches: Vec<_> = w.iter().map(|w| w.branch.clone().unwrap_or_default()).collect();
        assert_eq!(branches, ["main", "feature", "existing"]);
        assert!(!w[1].current);
        assert!(list(Path::new(&feat)).unwrap()[1].current);

        // Dirty worktrees need force.
        std::fs::write(Path::new(&feat).join("wip.txt"), "x").unwrap();
        assert!(remove(&main, &feat, false).is_err());
        remove(&main, &feat, true).unwrap();
        remove(&main, &other, false).unwrap();
        assert_eq!(list(&main).unwrap().len(), 1);
        assert!(!Path::new(&feat).exists());
    }
}
