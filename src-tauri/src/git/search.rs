//! Filtered history for the History view's search box: commit message,
//! author, file path, date range, a single branch/tag, or a hash prefix.
//! All filtering happens in git so paging works the same as the plain log.

use std::path::Path;

use serde::Deserialize;

use super::compare::resolve_commit;
use super::log::LogEntry;
use super::{run, GitError, GitResult};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LogQuery {
    pub skip: usize,
    pub limit: usize,
    /// Every branch and tag; ignored when `rev` is set.
    pub all: bool,
    /// Show this branch/tag/commit's ancestry instead of HEAD's.
    pub rev: Option<String>,
    /// Case-insensitive, literal match on the commit message.
    pub message: Option<String>,
    /// Case-insensitive, literal match on author name or email.
    pub author: Option<String>,
    /// Commits touching this path (file or folder).
    pub path: Option<String>,
    /// `YYYY-MM-DD`, inclusive.
    pub since: Option<String>,
    /// `YYYY-MM-DD`, inclusive.
    pub until: Option<String>,
    /// Abbreviated or full hash: returns just that commit, if it exists.
    pub hash: Option<String>,
}

const FORMAT: &str = "--format=%x1e%H%x00%h%x00%P%x00%an%x00%at%x00%D%x00%s";
const RS: char = '\u{1e}';

fn non_empty(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// Accepts only `YYYY-MM-DD`, so nothing else reaches git's date parser.
fn check_date(date: &str) -> GitResult<&str> {
    let b = date.as_bytes();
    let ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if ok {
        Ok(date)
    } else {
        Err(GitError::new(format!("{date} is not a date (use YYYY-MM-DD)")))
    }
}

/// Runs `git log` with `args` (options, revisions and optional `-- path`)
/// in Grove's log format. Shared with compare's ahead/behind lists.
pub(super) fn log_entries(root: &Path, args: &[&str]) -> GitResult<Vec<LogEntry>> {
    let mut full = vec!["log", "--decorate=short", "--no-color", FORMAT];
    full.extend_from_slice(args);
    let out = run(root, &full)?;
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

/// A page of history matching `q`, newest first in topological order.
pub fn search(root: &Path, q: &LogQuery) -> GitResult<Vec<LogEntry>> {
    if let Some(hash) = non_empty(&q.hash) {
        // Jump-to-commit: hex only, so it can't name a branch or an option.
        if !(4..=64).contains(&hash.len()) || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(Vec::new());
        }
        return match resolve_commit(root, hash) {
            Ok(full) => log_entries(root, &["-n1", &full, "--"]),
            Err(_) => Ok(Vec::new()),
        };
    }

    let skip = format!("--skip={}", q.skip);
    let limit = format!("-n{}", q.limit.max(1));
    let mut owned: Vec<String> = vec!["--topo-order".into(), skip, limit];
    if non_empty(&q.message).is_some() || non_empty(&q.author).is_some() {
        // Literal, case-insensitive: users type words, not regexes.
        owned.push("--regexp-ignore-case".into());
        owned.push("--fixed-strings".into());
    }
    if let Some(m) = non_empty(&q.message) {
        owned.push(format!("--grep={m}"));
    }
    if let Some(a) = non_empty(&q.author) {
        owned.push(format!("--author={a}"));
    }
    if let Some(d) = non_empty(&q.since) {
        owned.push(format!("--since={} 00:00:00", check_date(d)?));
    }
    if let Some(d) = non_empty(&q.until) {
        owned.push(format!("--until={} 23:59:59", check_date(d)?));
    }

    if let Some(rev) = non_empty(&q.rev) {
        owned.push(resolve_commit(root, rev)?);
    } else if q.all {
        owned.push("--all".into());
    } else if run(root, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
        return Ok(Vec::new()); // unborn branch
    }

    owned.push("--".into());
    if let Some(p) = non_empty(&q.path) {
        owned.push(p.to_string());
    }
    let args: Vec<&str> = owned.iter().map(String::as_str).collect();
    match log_entries(root, &args) {
        Ok(entries) => Ok(entries),
        // `--all` on a repo with no refs at all.
        Err(_) if q.all && non_empty(&q.rev).is_none() => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::compare::tests::{commit_file, repo};

    fn subjects(entries: &[LogEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.subject.as_str()).collect()
    }

    fn query() -> LogQuery {
        LogQuery { limit: 50, ..Default::default() }
    }

    #[test]
    fn filters_by_message_author_path_rev_and_hash() {
        let dir = repo();
        let root = dir.path();
        assert!(search(root, &LogQuery { message: Some("x".into()), ..query() }).unwrap().is_empty());

        commit_file(root, "a.txt", "1\n", "Add parser");
        commit_file(root, "src/b.txt", "1\n", "Fix PARSER bug [wip]");
        run(root, &["-c", "user.name=Other Person", "-c", "user.email=o@example.com", "commit", "-q", "--allow-empty", "-m", "Docs"]).unwrap();
        run(root, &["switch", "-qc", "side"]).unwrap();
        commit_file(root, "c.txt", "1\n", "Side parser");
        run(root, &["switch", "-q", "main"]).unwrap();

        // Message: case-insensitive and literal ("[wip]" isn't a regex class).
        let r = search(root, &LogQuery { message: Some("parser".into()), ..query() }).unwrap();
        assert_eq!(subjects(&r), ["Fix PARSER bug [wip]", "Add parser"]);
        let r = search(root, &LogQuery { message: Some("[wip]".into()), ..query() }).unwrap();
        assert_eq!(subjects(&r), ["Fix PARSER bug [wip]"]);
        let r = search(root, &LogQuery { message: Some("parser".into()), all: true, ..query() }).unwrap();
        assert_eq!(r.len(), 3);

        let r = search(root, &LogQuery { author: Some("other".into()), ..query() }).unwrap();
        assert_eq!(subjects(&r), ["Docs"]);

        let r = search(root, &LogQuery { path: Some("src".into()), ..query() }).unwrap();
        assert_eq!(subjects(&r), ["Fix PARSER bug [wip]"]);
        let r = search(root, &LogQuery { path: Some("src/b.txt".into()), ..query() }).unwrap();
        assert_eq!(r.len(), 1);

        let r = search(root, &LogQuery { rev: Some("side".into()), ..query() }).unwrap();
        assert_eq!(r[0].subject, "Side parser");
        assert!(search(root, &LogQuery { rev: Some("--all".into()), ..query() }).is_err());
        assert!(search(root, &LogQuery { rev: Some("nope".into()), ..query() }).is_err());

        // Paging over a filtered list.
        let r = search(root, &LogQuery { message: Some("parser".into()), skip: 1, limit: 1, ..Default::default() }).unwrap();
        assert_eq!(subjects(&r), ["Add parser"]);

        // Dates: everything here was committed today.
        let r = search(root, &LogQuery { since: Some("2000-01-01".into()), ..query() }).unwrap();
        assert_eq!(r.len(), 3);
        let r = search(root, &LogQuery { until: Some("2000-01-01".into()), ..query() }).unwrap();
        assert!(r.is_empty());
        assert!(search(root, &LogQuery { since: Some("yesterday".into()), ..query() }).is_err());

        let head = &search(root, &query()).unwrap()[0];
        let r = search(root, &LogQuery { hash: Some(head.hash[..7].into()), ..query() }).unwrap();
        assert_eq!(r[0].hash, head.hash);
        assert!(search(root, &LogQuery { hash: Some("main".into()), ..query() }).unwrap().is_empty());
        assert!(search(root, &LogQuery { hash: Some("ffffffff".into()), ..query() }).unwrap().is_empty());
    }
}
