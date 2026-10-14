//! Comparing two refs (branches, tags, commits), or a ref with the working
//! tree: changed files with line counts, the commits on each side, and the
//! two versions of a file for the diff editor.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use super::diff::{read, FileVersions, Source};
use super::log::LogEntry;
use super::search::log_entries;
use super::{run, GitError, GitResult};

/// Commits listed per side; a compare of unrelated branches could otherwise
/// return the whole history.
const MAX_COMMITS: usize = 1000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareFile {
    pub path: String,
    pub kind: char,
    /// Original path, for renames and copies.
    pub from: Option<String>,
    /// Line counts; `None` for binary files.
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    /// Full hash of the left side: A itself, or merge-base(A, B) for a
    /// three-dot compare. File reads use this so they match the file list
    /// even if a branch moves meanwhile.
    pub base: String,
    /// Full hash of B, or `None` for the working tree.
    pub head: Option<String>,
    pub files: Vec<CompareFile>,
    /// Commits in B that aren't in A (`A..B`).
    pub ahead: Vec<LogEntry>,
    /// Commits in A that aren't in B (`B..A`).
    pub behind: Vec<LogEntry>,
}

/// Resolves a user-supplied ref to a full commit hash. Only names git can
/// resolve to a commit are accepted, and never anything that looks like an
/// option.
pub(super) fn resolve_commit(root: &Path, rev: &str) -> GitResult<String> {
    let rev = rev.trim();
    if rev.is_empty() || rev.starts_with('-') {
        return Err(GitError::new(format!("\"{rev}\" is not a valid ref")));
    }
    run(root, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")])
        .map(|out| out.trim().to_string())
        .map_err(|_| GitError::new(format!("\"{rev}\" doesn't name a commit")))
}

/// Parses `git diff --numstat -z`: `added\tremoved\tpath\0`, or for renames
/// `added\tremoved\t\0old\0new\0`. Binary files show `-` counts. Keyed by
/// the new path.
fn parse_numstat(out: &str) -> HashMap<String, (Option<u32>, Option<u32>)> {
    let mut fields = out.split('\0');
    let mut map = HashMap::new();
    while let Some(field) = fields.next() {
        let mut parts = field.splitn(3, '\t');
        let (Some(a), Some(r), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let path = if path.is_empty() {
            let _old = fields.next();
            fields.next().unwrap_or_default()
        } else {
            path
        };
        map.insert(path.to_string(), (a.parse().ok(), r.parse().ok()));
    }
    map
}

/// Compares `a` with `b` (or the working tree when `b` is `None`).
/// Two-dot shows the difference between the two tips; three-dot shows only
/// what B changed since it diverged from A (`git diff A...B`).
pub fn compare(root: &Path, a: &str, b: Option<&str>, three_dot: bool) -> GitResult<Comparison> {
    let a = resolve_commit(root, a)?;
    let head = b.map(|b| resolve_commit(root, b)).transpose()?;
    // The working tree sits on HEAD, so that's its side of the commit lists.
    let tip = match &head {
        Some(h) => h.clone(),
        None => resolve_commit(root, "HEAD")?,
    };
    let base = if three_dot {
        run(root, &["merge-base", &a, &tip])
            .map(|o| o.trim().to_string())
            .map_err(|_| GitError::new("These have no common history, so there's no merge base to compare from."))?
    } else {
        a.clone()
    };

    let mut range = vec![base.as_str()];
    if let Some(h) = &head {
        range.push(h);
    }
    let diff = |opts: &[&str]| {
        let mut args = vec!["diff", "--no-color", "--no-ext-diff", "-z", "-M"];
        args.extend_from_slice(opts);
        args.extend_from_slice(&range);
        args.push("--");
        run(root, &args)
    };
    let mut counts = parse_numstat(&diff(&["--numstat"])?);
    let mut files: Vec<CompareFile> = super::stash::parse_name_status(&diff(&["--name-status"])?)
        .into_iter()
        .map(|f| {
            let (added, removed) = counts.remove(&f.path).unwrap_or((None, None));
            CompareFile { path: f.path, kind: f.kind, from: f.from, added, removed }
        })
        .collect();
    files.sort_by(|x, y| x.path.cmp(&y.path));

    let max = format!("-n{MAX_COMMITS}");
    let ahead = log_entries(root, &["--topo-order", &max, &format!("{a}..{tip}"), "--"])?;
    let behind = log_entries(root, &["--topo-order", &max, &format!("{tip}..{a}"), "--"])?;
    Ok(Comparison { base, head, files, ahead, behind })
}

/// Both versions of `path` for a compare: `base` (at `from` for renames)
/// against `head`, or the file on disk when `head` is `None`.
pub fn ref_versions(
    root: &Path,
    base: &str,
    head: Option<&str>,
    path: &str,
    from: Option<&str>,
) -> GitResult<FileVersions> {
    let base = resolve_commit(root, base)?;
    let original = read(root, Source::Rev(&base, from.unwrap_or(path)))?;
    let modified = match head {
        Some(h) => read(root, Source::Rev(&resolve_commit(root, h)?, path))?,
        None => read(root, Source::Worktree(path))?,
    };
    Ok(FileVersions { original, modified })
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "Tess"],
            &["config", "commit.gpgsign", "false"],
            &["config", "core.autocrlf", "false"],
        ] {
            run(dir.path(), args).unwrap();
        }
        dir
    }

    pub fn commit_file(root: &Path, name: &str, content: &str, msg: &str) {
        let full = root.join(name);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, content).unwrap();
        run(root, &["add", name]).unwrap();
        run(root, &["commit", "-qm", msg]).unwrap();
    }

    fn paths(c: &Comparison) -> Vec<&str> {
        c.files.iter().map(|f| f.path.as_str()).collect()
    }

    #[test]
    fn numstat_parsing() {
        let m = parse_numstat("3\t1\ta.txt\0-\t-\tbin.dat\0002\t0\t\0old.txt\0new.txt\0");
        assert_eq!(m["a.txt"], (Some(3), Some(1)));
        assert_eq!(m["bin.dat"], (None, None));
        assert_eq!(m["new.txt"], (Some(2), Some(0)));
        assert_eq!(m.len(), 3);
    }

    #[test]
    fn two_dot_three_dot_rename_and_worktree() {
        let dir = repo();
        let root = dir.path();
        commit_file(root, "shared.txt", "one\ntwo\n", "base");
        commit_file(root, "moved.txt", "a\nb\nc\nd\ne\n", "add moved");
        run(root, &["switch", "-qc", "feature"]).unwrap();
        commit_file(root, "feature.txt", "f\n", "feature work");
        run(root, &["mv", "moved.txt", "renamed.txt"]).unwrap();
        run(root, &["commit", "-qm", "rename"]).unwrap();
        run(root, &["switch", "-q", "main"]).unwrap();
        commit_file(root, "shared.txt", "one\ntwo\nthree\n", "main work");

        // Two-dot: tip vs tip, so main's own change shows up (reversed).
        let c = compare(root, "main", Some("feature"), false).unwrap();
        assert_eq!(paths(&c), ["feature.txt", "renamed.txt", "shared.txt"]);
        let shared = &c.files[2];
        assert_eq!((shared.kind, shared.added, shared.removed), ('M', Some(0), Some(1)));
        let renamed = &c.files[1];
        assert_eq!((renamed.kind, renamed.from.as_deref()), ('R', Some("moved.txt")));
        assert_eq!((renamed.added, renamed.removed), (Some(0), Some(0)));
        assert_eq!(c.ahead.iter().map(|e| e.subject.as_str()).collect::<Vec<_>>(), ["rename", "feature work"]);
        assert_eq!(c.behind.iter().map(|e| e.subject.as_str()).collect::<Vec<_>>(), ["main work"]);

        // Three-dot: only what feature did since branching.
        let c3 = compare(root, "main", Some("feature"), true).unwrap();
        assert_eq!(paths(&c3), ["feature.txt", "renamed.txt"]);
        assert_ne!(c3.base, c.base);
        let feature = &c3.files[0];
        assert_eq!((feature.kind, feature.added, feature.removed), ('A', Some(1), Some(0)));

        // File contents at each side, following the rename.
        let v = ref_versions(root, &c.base, c.head.as_deref(), "renamed.txt", Some("moved.txt")).unwrap();
        assert_eq!(v.original.text, v.modified.text);
        assert!(v.original.exists);
        let v = ref_versions(root, &c.base, c.head.as_deref(), "shared.txt", None).unwrap();
        assert_eq!((v.original.text.as_str(), v.modified.text.as_str()), ("one\ntwo\nthree\n", "one\ntwo\n"));
        let v = ref_versions(root, &c3.base, c3.head.as_deref(), "feature.txt", None).unwrap();
        assert!(!v.original.exists && v.modified.exists);

        // Working tree side: uncommitted edits count, HEAD is the commit side.
        std::fs::write(root.join("shared.txt"), "changed\n").unwrap();
        let w = compare(root, "feature", None, false).unwrap();
        assert!(w.head.is_none());
        assert!(paths(&w).contains(&"shared.txt"));
        assert_eq!(w.ahead.len(), 1);
        let v = ref_versions(root, &w.base, None, "shared.txt", None).unwrap();
        assert_eq!((v.original.text.as_str(), v.modified.text.as_str()), ("one\ntwo\n", "changed\n"));

        // Ref validation.
        assert!(compare(root, "--all", Some("main"), false).is_err());
        assert!(compare(root, "main", Some("nope"), false).is_err());
        assert!(ref_versions(root, "-x", None, "shared.txt", None).is_err());
        assert!(ref_versions(root, &c.base, None, "../escape", None).is_err());
        assert_eq!(resolve_commit(root, "v-missing").ok(), None);
        run(root, &["tag", "v1", "main"]).unwrap();
        assert_eq!(resolve_commit(root, "v1").unwrap(), resolve_commit(root, "main").unwrap());
    }

    #[test]
    fn unrelated_histories_have_no_merge_base() {
        let dir = repo();
        let root = dir.path();
        commit_file(root, "a.txt", "a\n", "a");
        run(root, &["switch", "-q", "--orphan", "other"]).unwrap();
        commit_file(root, "b.txt", "b\n", "b");
        assert!(compare(root, "main", Some("other"), true).is_err());
        assert_eq!(compare(root, "main", Some("other"), false).unwrap().files.len(), 2);
    }
}
