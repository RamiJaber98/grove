//! Submodules. A changed submodule is a moved commit pointer, not text, so
//! its "diff" is the old and new commits and the commits between them.

use std::path::Path;

use serde::Serialize;

use super::{repo_path, run, GitError, GitResult};

/// Commits listed between the old and new pointer, at most.
const MAX_COMMITS: usize = 200;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    pub path: String,
    /// Commit the superproject records (or has checked out, when `state` is +).
    pub hash: String,
    /// From `git submodule status`: ' ' in sync, '-' not initialised,
    /// '+' checked out at a different commit, 'U' merge conflict.
    pub state: char,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubCommit {
    pub hash: String,
    pub short: String,
    pub subject: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleDiff {
    pub old: Option<String>,
    pub new: Option<String>,
    /// The submodule is checked out, so its history can be read.
    pub initialized: bool,
    /// Commits in old..new, newest first (or new..old when `rewind`).
    pub commits: Vec<SubCommit>,
    /// The pointer moved backwards: `commits` are the ones being dropped.
    pub rewind: bool,
    /// Why commits couldn't be listed (e.g. objects not fetched).
    pub note: Option<String>,
}

pub fn list(root: &Path) -> GitResult<Vec<Submodule>> {
    let out = run(root, &["submodule", "status"])?;
    Ok(out.lines().filter_map(parse_status_line).collect())
}

/// ` 1234abcd path (describe)`, `-1234abcd path`, `+1234abcd path (…)`.
fn parse_status_line(line: &str) -> Option<Submodule> {
    let state = line.chars().next()?;
    let rest = &line[state.len_utf8()..];
    let (hash, rest) = rest.split_once(' ')?;
    // The trailing describe output is in parentheses; paths can contain spaces.
    let path = match rest.rfind(" (") {
        Some(i) if rest.ends_with(')') => &rest[..i],
        _ => rest,
    };
    Some(Submodule { path: path.to_string(), hash: hash.to_string(), state })
}

/// Resolves `<spec>` (`HEAD:path`, `:path`) to the gitlink's commit, if any.
fn gitlink(root: &Path, spec: &str) -> Option<String> {
    run(root, &["rev-parse", "--verify", "-q", spec]).ok().map(|s| s.trim().to_string())
}

/// The checked-out submodule's own git dir, when it's initialised. Checked
/// directly so an empty folder doesn't fall through to the superproject.
fn checkout_dir(root: &Path, path: &str) -> GitResult<Option<std::path::PathBuf>> {
    let dir = repo_path(root, path)?;
    Ok(dir.join(".git").exists().then_some(dir))
}

/// Old and new pointer for the diff selected in `group` (same groups as
/// `diff::versions`).
pub fn diff(root: &Path, group: &str, path: &str, rev: Option<&str>) -> GitResult<SubmoduleDiff> {
    let sub = checkout_dir(root, path)?;
    let (old, new) = match group {
        "changes" => (
            gitlink(root, &format!(":{path}")),
            match &sub {
                Some(dir) => gitlink(dir, "HEAD"),
                None => None,
            },
        ),
        "staged" => (gitlink(root, &format!("HEAD:{path}")), gitlink(root, &format!(":{path}"))),
        "commit" | "stash" => {
            let rev = rev.ok_or_else(|| GitError::new("missing commit"))?;
            if rev.starts_with('-') {
                return Err(GitError::new(format!("{rev} is not a commit")));
            }
            (gitlink(root, &format!("{rev}^1:{path}")), gitlink(root, &format!("{rev}:{path}")))
        }
        other => return Err(GitError::new(format!("unknown group {other}"))),
    };

    let mut result = SubmoduleDiff {
        old: old.clone(),
        new: new.clone(),
        initialized: sub.is_some(),
        commits: Vec::new(),
        rewind: false,
        note: None,
    };
    let (Some(dir), Some(old), Some(new)) = (sub, old, new) else {
        if !result.initialized {
            result.note = Some("The submodule isn't checked out, so its commits can't be listed.".into());
        }
        return Ok(result);
    };
    if old == new {
        result.note = Some("Same commit; the submodule has uncommitted changes of its own.".into());
        return Ok(result);
    }
    match commits_between(&dir, &old, &new) {
        Ok(c) if !c.is_empty() => result.commits = c,
        Ok(_) => {
            // Not ahead: maybe it moved backwards.
            result.commits = commits_between(&dir, &new, &old).unwrap_or_default();
            result.rewind = !result.commits.is_empty();
        }
        Err(_) => result.note = Some("Some commits aren't in the local submodule. Fetch or update it.".into()),
    }
    Ok(result)
}

fn commits_between(dir: &Path, from: &str, to: &str) -> GitResult<Vec<SubCommit>> {
    let limit = format!("-n{MAX_COMMITS}");
    let range = format!("{from}..{to}");
    let out = run(dir, &["log", &limit, "--format=%H%x00%h%x00%s", &range, "--"])?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.splitn(3, '\0').collect();
            (f.len() == 3).then(|| SubCommit { hash: f[0].into(), short: f[1].into(), subject: f[2].into() })
        })
        .collect())
}

/// Checks the submodule out at the commit the superproject records,
/// initialising (and recursing into) it if needed.
pub fn update(root: &Path, path: &str) -> GitResult<()> {
    repo_path(root, path)?;
    run(root, &["submodule", "update", "--init", "--recursive", "--", path]).map(drop)
}

/// Paths of submodules (gitlinks, mode 160000) changed between two commits;
/// `from` None means `to` is a root commit.
pub fn changed_between(root: &Path, from: Option<&str>, to: &str) -> GitResult<Vec<String>> {
    let out = match from {
        Some(from) => run(root, &["diff", "--raw", "-z", "--no-renames", "--no-abbrev", from, to])?,
        None => run(root, &["diff-tree", "--root", "-r", "--raw", "-z", "--no-renames", "--no-commit-id", to])?,
    };
    let fields: Vec<&str> = out.split('\0').collect();
    // With --no-renames each entry is ":<old mode> <new mode> <old> <new> <status>" then one path.
    Ok(fields
        .chunks(2)
        .filter(|c| c.len() == 2 && c[0].starts_with(':'))
        .filter(|c| c[0][1..].split(' ').take(2).any(|mode| mode == "160000"))
        .map(|c| c[1].to_string())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parses_submodule_status() {
        assert_eq!(
            parse_status_line(" abc123 libs/a b (v1.0)"),
            Some(Submodule { path: "libs/a b".into(), hash: "abc123".into(), state: ' ' })
        );
        assert_eq!(parse_status_line("-abc123 vendor/x").unwrap().state, '-');
        assert_eq!(parse_status_line("+abc123 x (heads/main)").unwrap().path, "x");
    }

    #[test]
    fn detects_and_diffs_submodules() {
        let tmp = tempfile::tempdir().unwrap();
        let (lib, app) = (tmp.path().join("lib"), tmp.path().join("app"));
        for d in [&lib, &app] {
            std::fs::create_dir(d).unwrap();
            run(d, &["init", "-q", "-b", "main"]).unwrap();
            configure(d);
        }
        run(&lib, &["commit", "--allow-empty", "-qm", "lib one"]).unwrap();
        run(&app, &["commit", "--allow-empty", "-qm", "app one"]).unwrap();
        // Local-path submodules are blocked by default since git 2.38.
        run(&app, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.to_str().unwrap(), "deps/lib"]).unwrap();
        run(&app, &["commit", "-qm", "add lib"]).unwrap();

        let subs = list(&app).unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!((subs[0].path.as_str(), subs[0].state), ("deps/lib", ' '));
        let head = run(&app, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(changed_between(&app, None, head.trim()).unwrap(), vec!["deps/lib".to_string()]);

        // Move the submodule forward two commits.
        let sub = app.join("deps/lib");
        configure(&sub);
        run(&sub, &["commit", "--allow-empty", "-qm", "lib two"]).unwrap();
        run(&sub, &["commit", "--allow-empty", "-qm", "lib three"]).unwrap();

        let s = crate::git::status::status(&app).unwrap();
        assert_eq!(s.submodules, vec!["deps/lib".to_string()]);
        assert_eq!(list(&app).unwrap()[0].state, '+');

        let d = diff(&app, "changes", "deps/lib", None).unwrap();
        assert!(d.initialized && !d.rewind);
        assert_ne!(d.old, d.new);
        assert_eq!(d.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["lib three", "lib two"]);

        // Staged and committed, the same move shows up in the other groups.
        run(&app, &["add", "deps/lib"]).unwrap();
        assert_eq!(diff(&app, "staged", "deps/lib", None).unwrap().commits.len(), 2);
        run(&app, &["commit", "-qm", "bump lib"]).unwrap();
        let head = run(&app, &["rev-parse", "HEAD"]).unwrap();
        let head = head.trim();
        assert_eq!(diff(&app, "commit", "deps/lib", Some(head)).unwrap().commits.len(), 2);
        let parent = format!("{head}^1");
        assert_eq!(changed_between(&app, Some(&parent), head).unwrap(), vec!["deps/lib".to_string()]);

        // Rewinding the checkout is reported as such; update puts it back.
        run(&sub, &["checkout", "-q", "HEAD~2"]).unwrap();
        let d = diff(&app, "changes", "deps/lib", None).unwrap();
        assert!(d.rewind);
        assert_eq!(d.commits.len(), 2);
        update(&app, "deps/lib").unwrap();
        assert!(crate::git::status::status(&app).unwrap().submodules.is_empty());
        assert!(update(&app, "../x").is_err());
    }
}
