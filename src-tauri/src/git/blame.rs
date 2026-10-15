//! Line-by-line authorship for the Blame view.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use super::log::check_hash;
use super::{repo_path, run_bytes, GitError, GitResult};

/// Same cap as the diff viewer: bigger files aren't sent to the editor.
const MAX_BYTES: usize = 5 * 1024 * 1024;
/// git's id for lines that only exist in the working tree.
const UNCOMMITTED: &str = "0000000000000000000000000000000000000000";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub time: i64,
    pub summary: String,
    /// The file's path in that commit (blame follows moves within history).
    pub path: String,
    /// True for lines that aren't committed yet.
    pub uncommitted: bool,
}

/// A run of consecutive lines last changed by the same commit.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameHunk {
    /// 1-based first line in the blamed file.
    pub start: usize,
    pub count: usize,
    pub hash: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blame {
    /// The file's content, rebuilt from blame's own output so lines always
    /// match the annotations.
    pub text: String,
    pub binary: bool,
    pub too_large: bool,
    pub hunks: Vec<BlameHunk>,
    pub commits: HashMap<String, BlameCommit>,
}

/// Blames `path` at `rev`: `None` is the working tree (uncommitted lines
/// included), otherwise `HEAD` or a commit hash. `-w` ignores whitespace-only
/// changes and `-M` sees through lines moved within the file, so reformatting
/// and reordering don't steal the credit for a line.
pub fn blame(root: &Path, path: &str, rev: Option<&str>) -> GitResult<Blame> {
    let full = repo_path(root, path)?;
    let rev = match rev {
        None => None,
        Some("HEAD") => Some("HEAD"),
        Some(r) => Some(check_hash(r)?),
    };

    let size = match rev {
        None => full.metadata().map_err(|_| GitError::new(format!("{path} does not exist")))?.len() as usize,
        Some(r) => {
            let spec = format!("{r}:{path}");
            let out = run_bytes(root, &["cat-file", "-s", &spec])
                .map_err(|_| GitError::new(format!("{path} does not exist in {r}")))?;
            String::from_utf8_lossy(&out).trim().parse().unwrap_or(0)
        }
    };
    if size > MAX_BYTES {
        return Ok(Blame { too_large: true, ..Default::default() });
    }

    // git blame refuses files that aren't in HEAD (new, untracked, or no
    // commits yet). Every line of those is uncommitted, so say that directly.
    if rev.is_none() && run_bytes(root, &["cat-file", "-e", &format!("HEAD:{path}")]).is_err() {
        let bytes = std::fs::read(&full).map_err(|e| GitError::new(format!("could not read {path}: {e}")))?;
        return Ok(all_uncommitted(path, &bytes));
    }

    let mut args = vec!["blame", "--porcelain", "-w", "-M"];
    args.extend(rev);
    args.extend(["--", path]);
    let out = run_bytes(root, &args)?;
    let mut blame = parse(&String::from_utf8_lossy(&out));
    if blame.text.contains('\0') {
        return Ok(Blame { binary: true, ..Default::default() });
    }
    // Avoid an empty annotation for a file that is entirely uncommitted.
    blame.commits.values_mut().for_each(|c| {
        if c.uncommitted {
            c.author = "Not committed yet".into();
            c.summary = "Not committed yet".into();
        }
    });
    Ok(blame)
}

/// A blame where every line is uncommitted, for files git can't blame yet.
fn all_uncommitted(path: &str, bytes: &[u8]) -> Blame {
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return Blame { binary: true, ..Default::default() };
    }
    let text = String::from_utf8_lossy(bytes).into_owned();
    let count = text.lines().count();
    let mut blame = Blame { text, ..Default::default() };
    if count > 0 {
        blame.hunks.push(BlameHunk { start: 1, count, hash: UNCOMMITTED.into() });
        blame.commits.insert(
            UNCOMMITTED.into(),
            BlameCommit {
                hash: UNCOMMITTED.into(),
                short: UNCOMMITTED[..7].into(),
                author: "Not committed yet".into(),
                time: 0,
                summary: "Not committed yet".into(),
                path: path.into(),
                uncommitted: true,
            },
        );
    }
    blame
}

/// Parses `git blame --porcelain`: per line a `<hash> <orig> <final> [<n>]`
/// header, commit metadata the first time a hash appears, then the line's
/// content after a tab.
fn parse(out: &str) -> Blame {
    let mut blame = Blame::default();
    let mut lines: Vec<&str> = Vec::new();
    let mut hash = String::new();
    let mut line_no = 0usize;

    for line in out.split('\n') {
        if let Some(content) = line.strip_prefix('\t') {
            lines.push(content);
            match blame.hunks.last_mut() {
                Some(h) if h.hash == hash && h.start + h.count == line_no => h.count += 1,
                _ => blame.hunks.push(BlameHunk { start: line_no, count: 1, hash: hash.clone() }),
            }
            continue;
        }
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        let is_header = key.len() >= 40 && key.chars().all(|c| c.is_ascii_hexdigit());
        if is_header {
            hash = key.to_string();
            line_no = value.split(' ').nth(1).and_then(|n| n.parse().ok()).unwrap_or(line_no + 1);
            blame.commits.entry(hash.clone()).or_insert_with(|| BlameCommit {
                hash: hash.clone(),
                short: hash[..7].to_string(),
                author: String::new(),
                time: 0,
                summary: String::new(),
                path: String::new(),
                uncommitted: hash == UNCOMMITTED,
            });
            continue;
        }
        let Some(c) = blame.commits.get_mut(&hash) else { continue };
        match key {
            "author" => c.author = value.to_string(),
            "author-time" => c.time = value.parse().unwrap_or(0),
            "summary" => c.summary = value.to_string(),
            "filename" => c.path = value.to_string(),
            _ => {}
        }
    }

    blame.text = lines.join("\n");
    if !lines.is_empty() {
        blame.text.push('\n');
    }
    blame
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::run;

    #[test]
    fn attributes_lines() {
        let dir = crate::git::file_log::tests::repo();
        let root = dir.path();
        let write = |s: &str| std::fs::write(root.join("f.txt"), s).unwrap();

        write("a\nb\nc\n");
        run(root, &["add", "f.txt"]).unwrap();
        run(root, &["commit", "-qm", "first"]).unwrap();
        let first = run(root, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        write("a\nB\nc\nd\n");
        run(root, &["commit", "-qam", "second"]).unwrap();
        let second = run(root, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        write("a\nB\nc\nd\nnew\n");

        let b = blame(root, "f.txt", None).unwrap();
        assert_eq!(b.text, "a\nB\nc\nd\nnew\n");
        let hunks: Vec<_> = b.hunks.iter().map(|h| (h.start, h.count, h.hash.as_str())).collect();
        assert_eq!(
            hunks,
            [(1, 1, first.as_str()), (2, 1, second.as_str()), (3, 1, first.as_str()), (4, 1, second.as_str()), (5, 1, UNCOMMITTED)]
        );
        assert_eq!(b.commits[&first].summary, "first");
        assert_eq!(b.commits[&second].author, "Tess");
        assert_eq!(b.commits[&second].path, "f.txt");
        assert!(b.commits[UNCOMMITTED].uncommitted);
        assert_eq!(b.commits[UNCOMMITTED].author, "Not committed yet");

        // HEAD has no uncommitted lines; an older commit sees only itself.
        let head = blame(root, "f.txt", Some("HEAD")).unwrap();
        assert_eq!(head.text, "a\nB\nc\nd\n");
        assert!(!head.commits.contains_key(UNCOMMITTED));
        let old = blame(root, "f.txt", Some(&first)).unwrap();
        assert_eq!(old.hunks, vec![BlameHunk { start: 1, count: 3, hash: first.clone() }]);

        assert!(blame(root, "f.txt", Some("--all")).is_err());
        assert!(blame(root, "../f.txt", None).is_err());
        assert!(blame(root, "missing.txt", Some("HEAD")).is_err());

        std::fs::write(root.join("bin.dat"), b"\x00\x01\n").unwrap();
        run(root, &["add", "bin.dat"]).unwrap();
        run(root, &["commit", "-qm", "bin"]).unwrap();
        assert!(blame(root, "bin.dat", None).unwrap().binary);
    }

    #[test]
    fn untracked_and_unborn_files_are_all_uncommitted() {
        let dir = crate::git::file_log::tests::repo();
        let root = dir.path();
        // No commits yet: git blame itself would fail here.
        std::fs::write(root.join("new.txt"), "one\ntwo\n").unwrap();
        let b = blame(root, "new.txt", None).unwrap();
        assert_eq!(b.text, "one\ntwo\n");
        assert_eq!(b.hunks, vec![BlameHunk { start: 1, count: 2, hash: UNCOMMITTED.into() }]);
        assert!(b.commits[UNCOMMITTED].uncommitted);

        run(root, &["commit", "--allow-empty", "-qm", "init"]).unwrap();
        assert_eq!(blame(root, "new.txt", None).unwrap().hunks.len(), 1, "untracked after a commit");
        assert!(blame(root, "new.txt", Some("HEAD")).is_err(), "not in HEAD");
        std::fs::write(root.join("empty.txt"), "").unwrap();
        assert!(blame(root, "empty.txt", None).unwrap().hunks.is_empty());
    }
}
