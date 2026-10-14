//! Working-tree status from `git status --porcelain=v2 -z`.
//! Format reference: https://git-scm.com/docs/git-status#_porcelain_format_version_2

use std::path::Path;

use serde::Serialize;

use super::{run, GitResult};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// One of M, A, D, R, C, U (untracked) or ! (conflicted).
    pub kind: char,
    /// Original path, for renames and copies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Current branch, or `None` on a detached HEAD.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// False on a freshly initialised repo with no commits yet.
    pub has_commits: bool,
    pub staged: Vec<FileChange>,
    pub changes: Vec<FileChange>,
    pub conflicts: Vec<FileChange>,
}

pub fn status(root: &Path) -> GitResult<Status> {
    let out = run(
        root,
        &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
    )?;
    Ok(parse(&out))
}

/// Maps a porcelain XY status letter to the letter shown in the panel.
fn kind(c: char) -> Option<char> {
    match c {
        'M' | 'T' => Some('M'),
        'A' => Some('A'),
        'D' => Some('D'),
        'R' => Some('R'),
        'C' => Some('C'),
        _ => None,
    }
}

fn change(path: &str, kind: char, from: Option<&str>) -> FileChange {
    FileChange {
        path: path.to_string(),
        kind,
        from: from.map(str::to_string),
    }
}

pub fn parse(out: &str) -> Status {
    let mut s = Status {
        has_commits: true,
        ..Default::default()
    };
    let mut records = out.split('\0').filter(|r| !r.is_empty());

    while let Some(rec) = records.next() {
        let Some((tag, rest)) = rec.split_once(' ') else { continue };
        match tag {
            "#" => {
                let (key, value) = rest.split_once(' ').unwrap_or((rest, ""));
                match key {
                    "branch.oid" => s.has_commits = value != "(initial)",
                    "branch.head" if value != "(detached)" => s.branch = Some(value.to_string()),
                    "branch.upstream" => s.upstream = Some(value.to_string()),
                    "branch.ab" => {
                        for part in value.split(' ') {
                            if let Some(n) = part.strip_prefix('+') {
                                s.ahead = n.parse().unwrap_or(0);
                            } else if let Some(n) = part.strip_prefix('-') {
                                s.behind = n.parse().unwrap_or(0);
                            }
                        }
                    }
                    _ => {}
                }
            }
            // 1 XY sub mH mI mW hH hI path
            "1" => {
                let f: Vec<&str> = rest.splitn(8, ' ').collect();
                if f.len() < 8 {
                    continue;
                }
                push_xy(&mut s, f[0], f[7], None);
            }
            // 2 XY sub mH mI mW hH hI Xscore path, then origPath as its own record
            "2" => {
                let f: Vec<&str> = rest.splitn(9, ' ').collect();
                let from = records.next();
                if f.len() < 9 {
                    continue;
                }
                push_xy(&mut s, f[0], f[8], from);
            }
            // u XY sub m1 m2 m3 mW h1 h2 h3 path
            "u" => {
                let f: Vec<&str> = rest.splitn(10, ' ').collect();
                if let Some(path) = f.get(9) {
                    s.conflicts.push(change(path, '!', None));
                }
            }
            "?" => s.changes.push(change(rest, 'U', None)),
            _ => {}
        }
    }

    for list in [&mut s.staged, &mut s.changes, &mut s.conflicts] {
        list.sort_by(|a, b| a.path.cmp(&b.path));
    }
    s
}

fn push_xy(s: &mut Status, xy: &str, path: &str, from: Option<&str>) {
    let mut chars = xy.chars();
    let (x, y) = (chars.next().unwrap_or('.'), chars.next().unwrap_or('.'));
    if let Some(k) = kind(x) {
        s.staged.push(change(path, k, if matches!(k, 'R' | 'C') { from } else { None }));
    }
    if let Some(k) = kind(y) {
        // A worktree-side rename/copy only happens with intent-to-add; show it as a modification.
        let k = if matches!(k, 'R' | 'C') { 'M' } else { k };
        s.changes.push(change(path, k, None));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_headers_and_entries() {
        let out = [
            "# branch.oid 1234567890abcdef",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "1 M. N... 100644 100644 100644 aaa bbb src/staged.rs",
            "1 .M N... 100644 100644 100644 aaa aaa src/dir with space/edited.ts",
            "1 MM N... 100644 100644 100644 aaa bbb both.txt",
            "1 D. N... 100644 000000 000000 aaa 000 gone.txt",
            "2 R. N... 100644 100644 100644 aaa aaa R100 new name.txt",
            "old name.txt",
            "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
            "? untracked.md",
            "",
        ]
        .join("\0");

        let s = parse(&out);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        assert!(s.has_commits);

        assert_eq!(
            s.staged,
            vec![
                change("both.txt", 'M', None),
                change("gone.txt", 'D', None),
                change("new name.txt", 'R', Some("old name.txt")),
                change("src/staged.rs", 'M', None),
            ]
        );
        assert_eq!(
            s.changes,
            vec![
                change("both.txt", 'M', None),
                change("src/dir with space/edited.ts", 'M', None),
                change("untracked.md", 'U', None),
            ]
        );
        assert_eq!(s.conflicts, vec![change("conflict.txt", '!', None)]);
    }

    #[test]
    fn handles_initial_and_detached() {
        let s = parse("# branch.oid (initial)\0# branch.head master\0");
        assert!(!s.has_commits);
        assert_eq!(s.branch.as_deref(), Some("master"));

        let s = parse("# branch.oid abc\0# branch.head (detached)\0");
        assert_eq!(s.branch, None);
    }
}
