//! File-level actions behind the Source Control panel's context menu:
//! .gitignore entries, resolving conflicts by taking one side, and turning
//! a stash into a branch.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::Path;

use serde::Deserialize;

use super::refs::check_branch_name;
use super::stash::check_ref;
use super::{nul_paths, ops, run, run_with_stdin, GitError, GitResult};

const PATHSPEC_STDIN: [&str; 2] = ["--pathspec-from-file=-", "--pathspec-file-nul"];

/// Appends `patterns` to the root .gitignore (creating it if needed) and
/// returns how many were actually added. Patterns already in the file are
/// skipped, the user's existing content is left byte-for-byte as it was,
/// and the file's own line ending style is kept.
pub fn add_to_gitignore(root: &Path, patterns: &[String]) -> GitResult<usize> {
    for p in patterns {
        // A newline would smuggle in a second pattern; `#` makes a comment.
        if p.trim().is_empty() || p.contains(['\n', '\r', '\0']) || p.starts_with('#') {
            return Err(GitError::new(format!("\"{p}\" isn't a valid .gitignore pattern.")));
        }
    }

    let file = root.join(".gitignore");
    let existing = match std::fs::read_to_string(&file) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(GitError::new(format!("could not read .gitignore: {e}"))),
    };
    let present: HashSet<&str> = existing.lines().map(str::trim_end).collect();

    let mut added: Vec<&str> = Vec::new();
    for p in patterns {
        let p = p.as_str();
        if !present.contains(p.trim_end()) && !added.contains(&p) {
            added.push(p);
        }
    }
    if added.is_empty() {
        return Ok(0);
    }

    let eol = if existing.contains("\r\n") { "\r\n" } else { "\n" };
    let mut text = String::new();
    if !existing.is_empty() && !existing.ends_with('\n') {
        text.push_str(eol);
    }
    for p in &added {
        text.push_str(p);
        text.push_str(eol);
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .and_then(|mut f| f.write_all(text.as_bytes()))
        .map_err(|e| GitError::new(format!("could not update .gitignore: {e}")))?;
    Ok(added.len())
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Ours,
    Theirs,
}

/// Resolves conflicted `paths` by taking one side's version wholesale, then
/// stages the result. When the chosen side deleted the file (a
/// modify/delete conflict) "taking" it means deleting it, which `git
/// checkout --ours/--theirs` can't do, so those paths are removed instead.
pub fn take_side(root: &Path, paths: &[String], side: Side) -> GitResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    // Index stage 2 holds "ours", stage 3 "theirs"; a missing stage means
    // that side deleted the file.
    let wanted = if side == Side::Ours { "2" } else { "3" };
    let mut stages: HashMap<String, HashSet<String>> = HashMap::new();
    for entry in run(root, &["ls-files", "-u", "-z"])?.split('\0') {
        // "<mode> <hash> <stage>\t<path>"
        if let Some((meta, path)) = entry.split_once('\t') {
            let stage = meta.rsplit(' ').next().unwrap_or_default().to_string();
            stages.entry(path.to_string()).or_default().insert(stage);
        }
    }
    let (keep, delete): (Vec<String>, Vec<String>) = paths
        .iter()
        .cloned()
        .partition(|p| stages.get(p).is_none_or(|s| s.contains(wanted)));

    let flag = if side == Side::Ours { "--ours" } else { "--theirs" };
    if !keep.is_empty() {
        let mut args = vec!["--literal-pathspecs", "checkout", flag];
        args.extend_from_slice(&PATHSPEC_STDIN);
        run_with_stdin(root, &args, &nul_paths(&keep))?;
        ops::stage(root, &keep)?;
    }
    if !delete.is_empty() {
        let mut args = vec!["--literal-pathspecs", "rm", "-q", "--ignore-unmatch"];
        args.extend_from_slice(&PATHSPEC_STDIN);
        run_with_stdin(root, &args, &nul_paths(&delete))?;
    }
    Ok(())
}

/// `git stash branch`: creates `name` at the commit the stash was made on,
/// checks it out, applies the stash there and drops it on success.
pub fn stash_branch(root: &Path, name: &str, r#ref: &str) -> GitResult<()> {
    check_ref(r#ref)?;
    check_branch_name(root, name)?;
    run(root, &["stash", "branch", name.trim(), r#ref]).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::stash;
    use crate::git::status::status;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "T"],
            &["config", "commit.gpgsign", "false"],
            &["config", "core.autocrlf", "false"],
        ] {
            run(dir.path(), args).unwrap();
        }
        dir
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn commit_all(root: &Path, message: &str) {
        run(root, &["add", "-A"]).unwrap();
        run(root, &["commit", "-qm", message]).unwrap();
    }

    #[test]
    fn gitignore_appends_without_duplicates() {
        let dir = repo();
        let root = dir.path();
        let file = root.join(".gitignore");

        // Created when missing.
        assert_eq!(add_to_gitignore(root, &strings(&["/a.log", "*.tmp", "/a.log"])).unwrap(), 2);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "/a.log\n*.tmp\n");

        // Existing patterns skipped, missing trailing newline fixed first.
        std::fs::write(&file, "node_modules\n*.tmp").unwrap();
        assert_eq!(add_to_gitignore(root, &strings(&["*.tmp", "build/"])).unwrap(), 1);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "node_modules\n*.tmp\nbuild/\n");
        assert_eq!(add_to_gitignore(root, &strings(&["build/"])).unwrap(), 0);

        // CRLF files stay CRLF.
        std::fs::write(&file, "a\r\nb").unwrap();
        add_to_gitignore(root, &strings(&["c"])).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "a\r\nb\r\nc\r\n");

        for bad in ["", "  ", "a\nb", "# comment"] {
            assert!(add_to_gitignore(root, &strings(&[bad])).is_err(), "{bad:?}");
        }

        // And git actually honours it.
        std::fs::write(root.join("x.tmp"), "x").unwrap();
        add_to_gitignore(root, &strings(&["*.tmp"])).unwrap();
        assert!(status(root).unwrap().changes.iter().all(|f| f.path != "x.tmp"));
    }

    #[test]
    fn take_side_resolves_conflicts() {
        let dir = repo();
        let root = dir.path();
        std::fs::write(root.join("c.txt"), "base\n").unwrap();
        std::fs::write(root.join("d.txt"), "base\n").unwrap();
        commit_all(root, "base");
        let main = run(root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim().to_string();

        run(root, &["checkout", "-q", "-b", "other"]).unwrap();
        std::fs::write(root.join("c.txt"), "theirs\n").unwrap();
        std::fs::write(root.join("d.txt"), "theirs\n").unwrap();
        commit_all(root, "other");

        run(root, &["checkout", "-q", &main]).unwrap();
        std::fs::write(root.join("c.txt"), "ours\n").unwrap();
        std::fs::remove_file(root.join("d.txt")).unwrap();
        commit_all(root, "main");

        assert!(run(root, &["merge", "other"]).is_err(), "merge should conflict");
        assert_eq!(status(root).unwrap().conflicts.len(), 2);

        take_side(root, &strings(&["c.txt"]), Side::Theirs).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("c.txt")).unwrap(), "theirs\n");
        // Ours deleted d.txt, so taking ours deletes it.
        take_side(root, &strings(&["d.txt"]), Side::Ours).unwrap();
        assert!(!root.join("d.txt").exists());

        let s = status(root).unwrap();
        assert!(s.conflicts.is_empty());
        assert!(s.staged.iter().any(|f| f.path == "c.txt"));
        run(root, &["commit", "-qm", "merged"]).unwrap();
    }

    #[test]
    fn take_side_keeps_ours() {
        let dir = repo();
        let root = dir.path();
        std::fs::write(root.join("c.txt"), "base\n").unwrap();
        commit_all(root, "base");
        let main = run(root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim().to_string();
        run(root, &["checkout", "-q", "-b", "other"]).unwrap();
        std::fs::write(root.join("c.txt"), "theirs\n").unwrap();
        commit_all(root, "other");
        run(root, &["checkout", "-q", &main]).unwrap();
        std::fs::write(root.join("c.txt"), "ours\n").unwrap();
        commit_all(root, "main");
        assert!(run(root, &["merge", "other"]).is_err());

        take_side(root, &strings(&["c.txt"]), Side::Ours).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("c.txt")).unwrap(), "ours\n");
        assert!(status(root).unwrap().conflicts.is_empty());
    }

    #[test]
    fn branch_from_stash() {
        let dir = repo();
        let root = dir.path();
        std::fs::write(root.join("a.txt"), "1").unwrap();
        commit_all(root, "init");
        std::fs::write(root.join("a.txt"), "2").unwrap();
        stash::push(root, "work", stash::StashMode::Tracked).unwrap();

        assert!(stash_branch(root, "bad name", "stash@{0}").is_err());
        assert!(stash_branch(root, "ok", "--exec").is_err());

        stash_branch(root, "from-stash", "stash@{0}").unwrap();
        assert_eq!(run(root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim(), "from-stash");
        assert!(stash::list(root).unwrap().is_empty(), "the stash is dropped");
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "2");
    }
}
