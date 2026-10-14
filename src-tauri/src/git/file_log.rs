//! History of a single file for the File History view, following renames.

use std::path::Path;

use serde::Serialize;

use super::{repo_path, run, GitResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLogEntry {
    pub hash: String,
    pub short: String,
    pub parents: Vec<String>,
    pub author: String,
    pub time: i64,
    pub subject: String,
    /// The file's path in this commit (differs from today's path before a rename).
    pub path: String,
    /// The path in the parent, when this commit renamed or copied the file.
    pub from: Option<String>,
    /// Status letter for the file in this commit (A, M, D, R, C, ...).
    /// Empty for merges, which git log shows without a diff.
    pub kind: String,
}

const RS: char = '\u{1e}';

/// One page of the commits that touched `path`, newest first. `--follow`
/// continues past renames; `--name-status` tells us what the file was called
/// in each commit so the diff can read the right blobs.
///
/// `--skip` doesn't combine with `--follow` (git stops tracking the rename
/// and returns nothing), so earlier pages are re-read and dropped instead.
/// File histories are short enough for that to be cheap.
pub fn file_log(root: &Path, path: &str, skip: usize, limit: usize) -> GitResult<Vec<FileLogEntry>> {
    repo_path(root, path)?;
    if run(root, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
        return Ok(Vec::new());
    }
    let count = format!("-n{}", skip + limit);
    let out = run(
        root,
        &[
            "log",
            "--follow",
            "-M",
            "-z",
            "--name-status",
            &count,
            "--format=%x1e%H%x00%h%x00%P%x00%an%x00%at%x00%s",
            "--",
            path,
        ],
    )?;
    Ok(parse(&out, path).into_iter().skip(skip).collect())
}

/// Parses records of six NUL-separated header fields followed by `-z`
/// name-status tokens (`M\0path` or `R100\0old\0new`).
fn parse(out: &str, start_path: &str) -> Vec<FileLogEntry> {
    // Merges carry no name-status, so they inherit the path of the newer
    // commit before them; walking newest-first makes that the previous entry.
    let mut current = start_path.to_string();
    let mut entries = Vec::new();
    for rec in out.split(RS) {
        let f: Vec<&str> = rec.split('\0').collect();
        if f.len() < 6 {
            continue;
        }
        let tokens: Vec<&str> = f[6..].iter().map(|t| t.trim_matches('\n')).filter(|t| !t.is_empty()).collect();
        let (mut kind, mut from, mut path) = (String::new(), None, current.clone());
        if let Some(status) = tokens.first() {
            let rename = status.starts_with('R') || status.starts_with('C');
            kind = status.chars().next().map(String::from).unwrap_or_default();
            if rename && tokens.len() >= 3 {
                from = Some(tokens[1].to_string());
                path = tokens[2].to_string();
            } else if let Some(p) = tokens.get(1) {
                path = p.to_string();
            }
        }
        // Older commits know the file by its pre-rename name.
        current = from.clone().unwrap_or_else(|| path.clone());
        entries.push(FileLogEntry {
            hash: f[0].to_string(),
            short: f[1].to_string(),
            parents: f[2].split_whitespace().map(str::to_string).collect(),
            author: f[3].to_string(),
            time: f[4].parse().unwrap_or(0),
            subject: f[5].trim_end_matches('\n').to_string(),
            path,
            from,
            kind,
        });
    }
    entries
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn repo() -> tempfile::TempDir {
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

    #[test]
    fn follows_renames() {
        let dir = repo();
        let root = dir.path();
        assert!(file_log(root, "a.txt", 0, 10).unwrap().is_empty());

        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        std::fs::write(root.join("other.txt"), "x\n").unwrap();
        run(root, &["add", "."]).unwrap();
        run(root, &["commit", "-qm", "add a"]).unwrap();
        std::fs::write(root.join("other.txt"), "y\n").unwrap();
        run(root, &["commit", "-qam", "unrelated"]).unwrap();
        std::fs::write(root.join("a.txt"), "one\ntwo\nthree\nfour\nfive\n").unwrap();
        run(root, &["commit", "-qam", "grow a"]).unwrap();
        run(root, &["mv", "a.txt", "src/b.txt"]).unwrap();
        run(root, &["commit", "-qm", "move a to b"]).unwrap();
        std::fs::write(root.join("src/b.txt"), "ONE\ntwo\nthree\nfour\nfive\n").unwrap();
        run(root, &["commit", "-qam", "edit b"]).unwrap();

        let log = file_log(root, "src/b.txt", 0, 10).unwrap();
        let summary: Vec<_> =
            log.iter().map(|e| (e.subject.as_str(), e.path.as_str(), e.from.as_deref(), e.kind.as_str())).collect();
        assert_eq!(
            summary,
            [
                ("edit b", "src/b.txt", None, "M"),
                ("move a to b", "src/b.txt", Some("a.txt"), "R"),
                ("grow a", "a.txt", None, "M"),
                ("add a", "a.txt", None, "A"),
            ]
        );
        assert_eq!(log[0].author, "Tess");
        assert_eq!(log[0].parents, vec![log[1].hash.clone()]);

        // Paging keeps rename tracking.
        let page = file_log(root, "src/b.txt", 2, 10).unwrap();
        assert_eq!(page.iter().map(|e| e.subject.as_str()).collect::<Vec<_>>(), ["grow a", "add a"]);
        assert_eq!(file_log(root, "src/b.txt", 0, 1).unwrap().len(), 1);

        // The renaming commit's diff reads the old path on the parent side.
        let v = crate::git::diff::versions(root, "commit", &log[1].path, log[1].from.as_deref(), Some(&log[1].hash))
            .unwrap();
        assert_eq!(v.original.text, v.modified.text);
        assert!(v.original.exists);

        assert!(file_log(root, "../x", 0, 10).is_err());
    }
}
