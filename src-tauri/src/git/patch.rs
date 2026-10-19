//! Partial staging: stage, unstage or discard individual hunks and lines.
//!
//! The diff viewer reports which lines the user picked as line numbers on
//! each side of the diff it shows. We ask git for the same diff, keep only
//! the picked changes and feed the result to `git apply`. Letting git apply
//! it (rather than writing blobs ourselves) means a patch that no longer
//! matches the file fails cleanly, and line-ending conversion follows the
//! repo's own config.

use std::path::Path;

use serde::Deserialize;

use super::{repo_path, run, run_bytes, run_with_stdin, GitError, GitResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchOp {
    /// Index → working tree changes into the index.
    Stage,
    /// HEAD → index changes back out of the index.
    Unstage,
    /// Index → working tree changes thrown away from the working tree.
    Discard,
}

/// Inclusive, 1-based line ranges on each side of the displayed diff: `old`
/// is the left (original) side, `new` the right (modified) side.
#[derive(Debug, Default, Deserialize)]
pub struct LineSelection {
    #[serde(default)]
    pub old: Vec<(u32, u32)>,
    #[serde(default)]
    pub new: Vec<(u32, u32)>,
}

fn in_ranges(ranges: &[(u32, u32)], n: u32) -> bool {
    ranges.iter().any(|&(a, b)| a <= n && n <= b)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Context,
    Removed,
    Added,
}

#[derive(Debug)]
struct Line {
    kind: Kind,
    /// Raw bytes without the trailing `\n` (a `\r` stays, for CRLF blobs).
    text: Vec<u8>,
    /// Followed by `\ No newline at end of file`.
    no_eol: bool,
    old: u32,
    new: u32,
    selected: bool,
}

#[derive(Debug)]
struct Hunk {
    old_start: u32,
    old_count: u32,
    new_start: u32,
    new_count: u32,
    lines: Vec<Line>,
}

#[derive(Debug)]
struct FileDiff {
    /// The file doesn't exist on the old side (new / untracked file).
    old_missing: bool,
    /// The file doesn't exist on the new side (deleted file).
    new_missing: bool,
    mode: String,
    hunks: Vec<Hunk>,
}

/// Both sides of the diff the viewer showed when the user picked lines.
#[derive(Debug, Deserialize)]
pub struct Shown {
    pub original: String,
    pub modified: String,
}

/// `apply_lines`, but only if the file still matches `shown`. The line
/// numbers refer to that diff; applied to a newer one they would pick other
/// lines, and `git apply` couldn't tell because the patch is built fresh.
pub fn apply_shown_lines(
    root: &Path,
    path: &str,
    from: Option<&str>,
    op: PatchOp,
    selection: &LineSelection,
    shown: &Shown,
) -> GitResult<()> {
    let group = if op == PatchOp::Unstage { "staged" } else { "changes" };
    let now = super::diff::versions(root, group, path, from, None)?;
    if now.original.text != shown.original || now.modified.text != shown.modified {
        return Err(GitError::new(
            "The file changed since its diff was shown. Check the updated diff and try again.",
        ));
    }
    apply_lines(root, path, from, op, selection)
}

/// Applies only the selected lines of `path`'s diff. `from` is the old path
/// of a rename, which isn't supported line by line.
pub fn apply_lines(
    root: &Path,
    path: &str,
    from: Option<&str>,
    op: PatchOp,
    selection: &LineSelection,
) -> GitResult<()> {
    let full_path = repo_path(root, path)?;
    if from.is_some_and(|f| f != path) {
        return Err(GitError::new(
            "Renamed files can't be staged line by line. Stage or unstage the whole file instead.",
        ));
    }

    let mut file = match parse(&diff(root, path, op)?)? {
        Some(f) => f,
        None if op != PatchOp::Unstage && is_untracked(root, path)? && full_path.is_file() => {
            untracked_diff(root, path)?
        }
        None => return Err(GitError::new(format!("{path} has no changes to apply."))),
    };

    let reverse = op != PatchOp::Stage;
    let (picked, total) = select(&mut file, selection, reverse);
    if picked == 0 {
        return Err(GitError::new("The selection doesn't include any changed lines."));
    }
    let patch = build(&file, path, reverse, picked == total);

    let mut args = vec!["apply", "--whitespace=nowarn"];
    match op {
        PatchOp::Stage => args.push("--cached"),
        PatchOp::Unstage => args.extend(["--cached", "--reverse"]),
        PatchOp::Discard => args.push("--reverse"),
    }
    args.push("-");
    run_with_stdin(root, &args, &patch).map(drop).map_err(|e| {
        GitError::new(format!(
            "Couldn't apply the change; the file may have changed since it was shown.\n{}",
            e.message
        ))
    })
}

/// The diff the viewer shows for this operation, as git sees it (clean,
/// i.e. after line-ending conversion, which is what `git apply` expects).
fn diff(root: &Path, path: &str, op: PatchOp) -> GitResult<Vec<u8>> {
    // Explicit flags override user config that would change the format
    // (textconv, external diff tools, noprefix, colour).
    let mut args = vec![
        "--literal-pathspecs",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--unified=3",
        "--src-prefix=a/",
        "--dst-prefix=b/",
    ];
    if op == PatchOp::Unstage {
        args.push("--cached");
    }
    args.extend(["--", path]);
    run_bytes(root, &args)
}

fn is_untracked(root: &Path, path: &str) -> GitResult<bool> {
    Ok(run(root, &["--literal-pathspecs", "ls-files", "--", path])?.trim().is_empty())
}

/// `git diff` doesn't show untracked files, so build the "everything is
/// added" diff ourselves from the cleaned content (`hash-object` runs the
/// same filters as `git add`, e.g. CRLF → LF with autocrlf).
fn untracked_diff(root: &Path, path: &str) -> GitResult<FileDiff> {
    let oid = run(root, &["hash-object", "-w", "--", path])?.trim().to_string();
    let bytes = run_bytes(root, &["cat-file", "blob", &oid])?;
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return Err(GitError::new("Binary files can't be staged line by line."));
    }
    let mut lines = Vec::new();
    let mut rest = &bytes[..];
    while !rest.is_empty() {
        let (text, no_eol, next) = match rest.iter().position(|&b| b == b'\n') {
            Some(i) => (&rest[..i], false, &rest[i + 1..]),
            None => (rest, true, &rest[rest.len()..]),
        };
        let n = lines.len() as u32 + 1;
        lines.push(Line { kind: Kind::Added, text: text.to_vec(), no_eol, old: 0, new: n, selected: false });
        rest = next;
    }
    if lines.is_empty() {
        return Err(GitError::new(format!("{path} is empty; stage the whole file instead.")));
    }
    let new_count = lines.len() as u32;
    Ok(FileDiff {
        old_missing: true,
        new_missing: false,
        mode: untracked_mode(&root.join(path)).into(),
        hunks: vec![Hunk { old_start: 0, old_count: 0, new_start: 1, new_count, lines }],
    })
}

#[cfg(unix)]
fn untracked_mode(path: &Path) -> &'static str {
    use std::os::unix::fs::PermissionsExt;
    match path.metadata() {
        Ok(m) if m.permissions().mode() & 0o111 != 0 => "100755",
        _ => "100644",
    }
}

#[cfg(not(unix))]
fn untracked_mode(_: &Path) -> &'static str {
    "100644"
}

/// Parses `a,b` / `a` from a hunk header.
fn parse_range(s: &str) -> Option<(u32, u32)> {
    match s.split_once(',') {
        Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
        None => Some((s.parse().ok()?, 1)),
    }
}

fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let (old_start, old_count) = parse_range(old)?;
    let (new_start, new_count) = parse_range(new)?;
    Some((old_start, old_count, new_start, new_count))
}

/// Parses a single-file `git diff` into hunks. `None` when there's no diff.
fn parse(diff: &[u8]) -> GitResult<Option<FileDiff>> {
    if diff.is_empty() {
        return Ok(None);
    }
    let unsupported = || GitError::new("This change can't be staged line by line.");
    let mut file = FileDiff { old_missing: false, new_missing: false, mode: "100644".into(), hunks: Vec::new() };
    let mut files = 0;
    // Lines still expected in the current hunk, and the next line numbers.
    let (mut left_old, mut left_new, mut old_no, mut new_no) = (0u32, 0u32, 0u32, 0u32);

    let mut raw: Vec<&[u8]> = diff.split(|&b| b == b'\n').collect();
    if raw.last().is_some_and(|l| l.is_empty()) {
        raw.pop();
    }
    for line in raw {
        if line.starts_with(b"\\") {
            // "\ No newline at end of file" belongs to the line before it.
            if let Some(last) = file.hunks.last_mut().and_then(|h| h.lines.last_mut()) {
                last.no_eol = true;
            }
            continue;
        }
        if left_old > 0 || left_new > 0 {
            // diff.suppressBlankEmpty prints empty context lines without the space.
            let (kind, text) = match line.first() {
                None => (Kind::Context, &line[..0]),
                Some(b' ') => (Kind::Context, &line[1..]),
                Some(b'-') => (Kind::Removed, &line[1..]),
                Some(b'+') => (Kind::Added, &line[1..]),
                _ => return Err(unsupported()),
            };
            let (old, new) = match kind {
                Kind::Context => (old_no, new_no),
                Kind::Removed => (old_no, 0),
                Kind::Added => (0, new_no),
            };
            if kind != Kind::Added {
                old_no += 1;
                left_old = left_old.checked_sub(1).ok_or_else(unsupported)?;
            }
            if kind != Kind::Removed {
                new_no += 1;
                left_new = left_new.checked_sub(1).ok_or_else(unsupported)?;
            }
            let hunk = file.hunks.last_mut().ok_or_else(unsupported)?;
            hunk.lines.push(Line { kind, text: text.to_vec(), no_eol: false, old, new, selected: false });
            continue;
        }

        let text = String::from_utf8_lossy(line);
        if text.starts_with("diff --git ") {
            files += 1;
            if files > 1 {
                return Err(unsupported());
            }
        } else if let Some(mode) = text.strip_prefix("new file mode ") {
            file.old_missing = true;
            file.mode = mode.trim().to_string();
        } else if let Some(mode) = text.strip_prefix("deleted file mode ") {
            file.new_missing = true;
            file.mode = mode.trim().to_string();
        } else if text.starts_with("Binary files ") || text.starts_with("GIT binary patch") {
            return Err(GitError::new("Binary files can't be staged line by line."));
        } else if text.starts_with("@@ ") {
            let (old_start, old_count, new_start, new_count) = parse_hunk_header(&text).ok_or_else(unsupported)?;
            (left_old, left_new) = (old_count, new_count);
            old_no = if old_count == 0 { old_start + 1 } else { old_start };
            new_no = if new_count == 0 { new_start + 1 } else { new_start };
            file.hunks.push(Hunk { old_start, old_count, new_start, new_count, lines: Vec::new() });
        }
    }
    if file.hunks.is_empty() {
        // Mode-only changes, submodules and the like.
        return Err(unsupported());
    }
    Ok(Some(file))
}

/// Marks the changed lines the user picked; returns (picked, total).
/// `reverse` is how the patch will be applied (see `build`).
fn select(file: &mut FileDiff, selection: &LineSelection, reverse: bool) -> (usize, usize) {
    let (mut picked, mut total) = (0, 0);
    for hunk in &mut file.hunks {
        for line in &mut hunk.lines {
            line.selected = match line.kind {
                Kind::Context => false,
                Kind::Removed => in_ranges(&selection.old, line.old),
                Kind::Added => in_ranges(&selection.new, line.new),
            };
        }
        // When the old file's last line has no newline, keeping it while
        // taking additions after it would leave a line without a newline in
        // the middle of the file, which no patch can express; take the whole
        // run of changes instead (that gives the line its newline).
        let mut start = 0;
        while start < hunk.lines.len() {
            if hunk.lines[start].kind == Kind::Context {
                start += 1;
                continue;
            }
            let end = hunk.lines[start..]
                .iter()
                .position(|l| l.kind == Kind::Context)
                .map_or(hunk.lines.len(), |i| start + i);
            let run = &mut hunk.lines[start..end];
            if let Some(i) = run.iter().position(|l| l.kind == Kind::Removed && l.no_eol) {
                // Forward keeps unpicked removals; reverse keeps unpicked additions.
                let kept = if reverse { run[i].selected } else { !run[i].selected };
                let after = run[i + 1..].iter().any(|l| l.kind == Kind::Added && l.selected != reverse);
                if kept && after {
                    run.iter_mut().for_each(|l| l.selected = true);
                }
            }
            start = end;
        }
        for line in &hunk.lines {
            if line.kind != Kind::Context {
                total += 1;
                picked += line.selected as usize;
            }
        }
    }
    (picked, total)
}

/// C-style quoting, which `git apply` accepts for any path.
fn quote(path: &str) -> String {
    let mut out = String::from("\"");
    for c in path.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Builds a patch with only the selected changes.
///
/// Forward (stage): applied to the old side, so every old line must stay:
/// unpicked removals become context and unpicked additions are dropped.
/// Reverse (unstage / discard): applied backwards to the new side, so every
/// new line must stay: unpicked additions become context and unpicked
/// removals are dropped.
fn build(file: &FileDiff, path: &str, reverse: bool, full: bool) -> Vec<u8> {
    // The side the patch produces only stays missing if every change is
    // taken (e.g. staging part of a deletion leaves the file in the index).
    let old_null = file.old_missing && (!reverse || full);
    let new_null = file.new_missing && (reverse || full);
    let a = quote(&format!("a/{path}"));
    let b = quote(&format!("b/{path}"));

    let mut out = format!("diff --git {a} {b}\n");
    if old_null {
        out += &format!("new file mode {}\n", file.mode);
    }
    if new_null {
        out += &format!("deleted file mode {}\n", file.mode);
    }
    out += &format!("--- {}\n", if old_null { "/dev/null" } else { &a });
    out += &format!("+++ {}\n", if new_null { "/dev/null" } else { &b });
    let mut out = out.into_bytes();

    // Net lines added by the hunks written so far; shifts the side that
    // isn't fixed by git's numbering.
    let mut delta: i64 = 0;
    for hunk in &file.hunks {
        if !hunk.lines.iter().any(|l| l.selected) {
            continue;
        }
        let mut body = Vec::new();
        let (mut old_count, mut new_count) = (0i64, 0i64);
        for line in &hunk.lines {
            let prefix = match (line.kind, line.selected, reverse) {
                (Kind::Context, ..) => b' ',
                (Kind::Removed, true, _) => b'-',
                (Kind::Added, true, _) => b'+',
                (Kind::Removed, false, false) | (Kind::Added, false, true) => b' ',
                (Kind::Removed, false, true) | (Kind::Added, false, false) => continue,
            };
            if prefix != b'+' {
                old_count += 1;
            }
            if prefix != b'-' {
                new_count += 1;
            }
            body.push(prefix);
            body.extend_from_slice(&line.text);
            body.push(b'\n');
            if line.no_eol {
                body.extend_from_slice(b"\\ No newline at end of file\n");
            }
        }

        // First line of the hunk on each side; a zero-length side names the
        // line *before* it in the header.
        let first = |start: u32, count: u32| if count == 0 { start as i64 + 1 } else { start as i64 };
        let (old_first, new_first) = if reverse {
            let new_first = first(hunk.new_start, hunk.new_count);
            (new_first - delta, new_first)
        } else {
            let old_first = first(hunk.old_start, hunk.old_count);
            (old_first, old_first + delta)
        };
        delta += new_count - old_count;
        let start = |first: i64, count: i64| if count == 0 { first - 1 } else { first };
        out.extend_from_slice(
            format!(
                "@@ -{},{} +{},{} @@\n",
                start(old_first, old_count),
                old_count,
                start(new_first, new_count),
                new_count
            )
            .as_bytes(),
        );
        out.extend_from_slice(&body);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "T"],
            &["config", "core.autocrlf", "false"],
        ] {
            run(dir.path(), args).unwrap();
        }
        dir
    }

    fn commit_file(root: &Path, path: &str, content: &str) {
        std::fs::write(root.join(path), content).unwrap();
        run(root, &["add", path]).unwrap();
        run(root, &["commit", "-qm", "c"]).unwrap();
    }

    /// The staged blob, raw (no smudge filters).
    fn index(root: &Path, path: &str) -> String {
        String::from_utf8(run_bytes(root, &["cat-file", "blob", &format!(":{path}")]).unwrap()).unwrap()
    }

    fn disk(root: &Path, path: &str) -> String {
        std::fs::read_to_string(root.join(path)).unwrap()
    }

    fn sel(old: &[(u32, u32)], new: &[(u32, u32)]) -> LineSelection {
        LineSelection { old: old.to_vec(), new: new.to_vec() }
    }

    fn numbered(n: u32) -> String {
        (1..=n).map(|i| format!("line {i}\n")).collect()
    }

    #[test]
    fn stages_one_hunk_of_two() {
        let dir = repo();
        let root = dir.path();
        let base = numbered(20);
        commit_file(root, "f.txt", &base);
        let edited = base.replace("line 2\n", "line two\n").replace("line 18\n", "line eighteen\n");
        std::fs::write(root.join("f.txt"), &edited).unwrap();

        // The second hunk, as the viewer reports it.
        apply_lines(root, "f.txt", None, PatchOp::Stage, &sel(&[(18, 18)], &[(18, 18)])).unwrap();
        assert_eq!(index(root, "f.txt"), base.replace("line 18\n", "line eighteen\n"));
        assert_eq!(disk(root, "f.txt"), edited);

        // Then the first; the index now matches the working tree.
        apply_lines(root, "f.txt", None, PatchOp::Stage, &sel(&[(2, 2)], &[(2, 2)])).unwrap();
        assert_eq!(index(root, "f.txt"), edited);
    }

    #[test]
    fn stages_some_lines_within_a_hunk() {
        let dir = repo();
        let root = dir.path();
        commit_file(root, "f.txt", "a\nb\nc\nd\n");
        std::fs::write(root.join("f.txt"), "a\nx\ny\nz\nc\nd\n").unwrap();
        // Diff: -b +x +y +z. Pick only the addition of y.
        apply_lines(root, "f.txt", None, PatchOp::Stage, &sel(&[], &[(3, 3)])).unwrap();
        assert_eq!(index(root, "f.txt"), "a\nb\ny\nc\nd\n");

        // Now index → disk is -b +x, z added after y. Stage the removal of b.
        apply_lines(root, "f.txt", None, PatchOp::Stage, &sel(&[(2, 2)], &[])).unwrap();
        assert_eq!(index(root, "f.txt"), "a\ny\nc\nd\n");
    }

    #[test]
    fn later_hunks_shift_after_partial_ones() {
        let dir = repo();
        let root = dir.path();
        let base = numbered(30);
        commit_file(root, "f.txt", &base);
        let edited = base
            .replace("line 3\n", "new a\nnew b\nline 3\n")
            .replace("line 25\n", "line 25\nnew c\n");
        std::fs::write(root.join("f.txt"), &edited).unwrap();
        // One line of the first hunk (new line 4 = "new b") and all of the second.
        apply_lines(root, "f.txt", None, PatchOp::Stage, &sel(&[], &[(4, 4), (28, 28)])).unwrap();
        let expected = base.replace("line 3\n", "new b\nline 3\n").replace("line 25\n", "line 25\nnew c\n");
        assert_eq!(index(root, "f.txt"), expected);
    }

    #[test]
    fn unstages_lines() {
        let dir = repo();
        let root = dir.path();
        commit_file(root, "f.txt", "a\nb\nc\n");
        std::fs::write(root.join("f.txt"), "a\nB\nc\nd\ne\n").unwrap();
        run(root, &["add", "f.txt"]).unwrap();
        // HEAD → index: -b +B, +d +e. Unstage the "d" line only.
        apply_lines(root, "f.txt", None, PatchOp::Unstage, &sel(&[], &[(4, 4)])).unwrap();
        assert_eq!(index(root, "f.txt"), "a\nB\nc\ne\n");
        // Unstage the b → B replacement (both sides picked).
        apply_lines(root, "f.txt", None, PatchOp::Unstage, &sel(&[(2, 2)], &[(2, 2)])).unwrap();
        assert_eq!(index(root, "f.txt"), "a\nb\nc\ne\n");
        assert_eq!(disk(root, "f.txt"), "a\nB\nc\nd\ne\n");
    }

    #[test]
    fn discards_lines() {
        let dir = repo();
        let root = dir.path();
        let base = numbered(20);
        commit_file(root, "f.txt", &base);
        let edited = base.replace("line 2\n", "line two\nextra\n").replace("line 18\n", "");
        std::fs::write(root.join("f.txt"), &edited).unwrap();
        // Throw away the added "extra" line and the removal of line 18.
        apply_lines(root, "f.txt", None, PatchOp::Discard, &sel(&[(18, 18)], &[(3, 3)])).unwrap();
        assert_eq!(disk(root, "f.txt"), base.replace("line 2\n", "line two\n"));
        assert_eq!(index(root, "f.txt"), base);
    }

    #[test]
    fn stages_part_of_an_untracked_file() {
        let dir = repo();
        let root = dir.path();
        commit_file(root, "keep.txt", "k\n");
        std::fs::write(root.join("new file.txt"), "x\ny\nz").unwrap();
        apply_lines(root, "new file.txt", None, PatchOp::Stage, &sel(&[], &[(2, 2)])).unwrap();
        assert_eq!(index(root, "new file.txt"), "y\n");
        // The rest (z has no trailing newline).
        apply_lines(root, "new file.txt", None, PatchOp::Stage, &sel(&[], &[(1, 1), (3, 3)])).unwrap();
        assert_eq!(index(root, "new file.txt"), "x\ny\nz");

        // Discarding part of an untracked file edits it; all of it deletes it.
        std::fs::write(root.join("other.txt"), "1\n2\n3\n").unwrap();
        apply_lines(root, "other.txt", None, PatchOp::Discard, &sel(&[], &[(2, 2)])).unwrap();
        assert_eq!(disk(root, "other.txt"), "1\n3\n");
        apply_lines(root, "other.txt", None, PatchOp::Discard, &sel(&[], &[(1, 2)])).unwrap();
        assert!(!root.join("other.txt").exists());
    }

    #[test]
    fn handles_new_and_deleted_files() {
        let dir = repo();
        let root = dir.path();
        // No commits yet: everything staged is a new file.
        std::fs::write(root.join("f.txt"), "a\nb\nc\n").unwrap();
        run(root, &["add", "f.txt"]).unwrap();
        apply_lines(root, "f.txt", None, PatchOp::Unstage, &sel(&[], &[(1, 1)])).unwrap();
        assert_eq!(index(root, "f.txt"), "b\nc\n");
        // Unstaging every line removes it from the index again.
        apply_lines(root, "f.txt", None, PatchOp::Unstage, &sel(&[], &[(1, 2)])).unwrap();
        assert!(run(root, &["ls-files"]).unwrap().is_empty());

        run(root, &["add", "f.txt"]).unwrap();
        run(root, &["commit", "-qm", "c"]).unwrap();
        std::fs::remove_file(root.join("f.txt")).unwrap();
        // Staging part of a deletion leaves the rest in the index.
        apply_lines(root, "f.txt", None, PatchOp::Stage, &sel(&[(2, 2)], &[])).unwrap();
        assert_eq!(index(root, "f.txt"), "a\nc\n");
        // Discarding part of a deletion brings those lines back.
        apply_lines(root, "f.txt", None, PatchOp::Discard, &sel(&[(1, 1)], &[])).unwrap();
        assert_eq!(disk(root, "f.txt"), "a\n");
    }

    #[test]
    fn missing_newline_at_end_of_file() {
        let dir = repo();
        let root = dir.path();
        let base = format!("{}last", numbered(10));
        commit_file(root, "f.txt", &base);
        let edited = format!("{}last\nmore\n", numbered(10).replace("line 1\n", "first\n"));
        std::fs::write(root.join("f.txt"), &edited).unwrap();
        // Picking just "more" also has to give "last" its newline.
        apply_lines(root, "f.txt", None, PatchOp::Stage, &sel(&[], &[(12, 12)])).unwrap();
        assert_eq!(index(root, "f.txt"), format!("{}last\nmore\n", numbered(10)));

        // Unstaging just "more" can leave the added newline staged...
        apply_lines(root, "f.txt", None, PatchOp::Unstage, &sel(&[], &[(12, 12)])).unwrap();
        assert_eq!(index(root, "f.txt"), format!("{}last\n", numbered(10)));
        // ...and unstaging the rest restores the original ending.
        apply_lines(root, "f.txt", None, PatchOp::Unstage, &sel(&[(11, 11)], &[(11, 11)])).unwrap();
        assert_eq!(index(root, "f.txt"), base);

        // Discarding the first hunk leaves the end-of-file change alone.
        apply_lines(root, "f.txt", None, PatchOp::Discard, &sel(&[(1, 1)], &[(1, 1)])).unwrap();
        assert_eq!(disk(root, "f.txt"), format!("{}last\nmore\n", numbered(10)));
    }

    #[test]
    fn crlf_with_autocrlf() {
        let dir = repo();
        let root = dir.path();
        run(root, &["config", "core.autocrlf", "true"]).unwrap();
        commit_file(root, "f.txt", "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nj\r\n");
        assert_eq!(index(root, "f.txt"), "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");
        std::fs::write(root.join("f.txt"), "A\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nJ\r\n").unwrap();

        apply_lines(root, "f.txt", None, PatchOp::Stage, &sel(&[(1, 1)], &[(1, 1)])).unwrap();
        assert_eq!(index(root, "f.txt"), "A\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");

        apply_lines(root, "f.txt", None, PatchOp::Discard, &sel(&[(10, 10)], &[(10, 10)])).unwrap();
        assert_eq!(disk(root, "f.txt"), "A\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nj\r\n");

        // Untracked CRLF file: staged lines are normalised like `git add`.
        std::fs::write(root.join("u.txt"), "1\r\n2\r\n3\r\n").unwrap();
        apply_lines(root, "u.txt", None, PatchOp::Stage, &sel(&[], &[(2, 3)])).unwrap();
        assert_eq!(index(root, "u.txt"), "2\n3\n");
    }

    #[test]
    fn crlf_stored_in_the_repo() {
        let dir = repo();
        let root = dir.path();
        commit_file(root, "f.txt", "a\r\nb\r\nc\r\n");
        std::fs::write(root.join("f.txt"), "a\r\nB\r\nc\r\nd\r\n").unwrap();
        apply_lines(root, "f.txt", None, PatchOp::Stage, &sel(&[], &[(4, 4)])).unwrap();
        assert_eq!(index(root, "f.txt"), "a\r\nb\r\nc\r\nd\r\n");
        apply_lines(root, "f.txt", None, PatchOp::Discard, &sel(&[(2, 2)], &[(2, 2)])).unwrap();
        assert_eq!(disk(root, "f.txt"), "a\r\nb\r\nc\r\nd\r\n");
    }

    #[test]
    fn rejects_bad_requests() {
        let dir = repo();
        let root = dir.path();
        commit_file(root, "f.txt", "a\nb\n");
        std::fs::write(root.join("f.txt"), "a\nB\n").unwrap();
        // Nothing changed on the picked lines.
        assert!(apply_lines(root, "f.txt", None, PatchOp::Stage, &sel(&[(1, 1)], &[(1, 1)])).is_err());
        // Nothing staged.
        assert!(apply_lines(root, "f.txt", None, PatchOp::Unstage, &sel(&[(2, 2)], &[(2, 2)])).is_err());
        assert!(apply_lines(root, "f.txt", Some("old.txt"), PatchOp::Stage, &sel(&[], &[(2, 2)])).is_err());
        assert!(apply_lines(root, "../f.txt", None, PatchOp::Stage, &sel(&[], &[(2, 2)])).is_err());
        assert_eq!(index(root, "f.txt"), "a\nb\n");
    }

    #[test]
    fn refuses_lines_from_a_stale_diff() {
        let dir = repo();
        let root = dir.path();
        commit_file(root, "f.txt", "a\nb\nc\n");
        std::fs::write(root.join("f.txt"), "a\nB\nc\n").unwrap();
        let shown = Shown { original: "a\nb\nc\n".into(), modified: "a\nB\nc\n".into() };

        // A line was added at the top after the diff was drawn: line 2 now
        // means something else, so nothing is discarded.
        std::fs::write(root.join("f.txt"), "new\na\nB\nc\n").unwrap();
        let err = apply_shown_lines(root, "f.txt", None, PatchOp::Discard, &sel(&[(2, 2)], &[(2, 2)]), &shown).unwrap_err();
        assert!(err.message.contains("changed since"), "{}", err.message);
        assert_eq!(disk(root, "f.txt"), "new\na\nB\nc\n");

        // Matching what was shown, it applies.
        std::fs::write(root.join("f.txt"), "a\nB\nc\n").unwrap();
        apply_shown_lines(root, "f.txt", None, PatchOp::Stage, &sel(&[(2, 2)], &[(2, 2)]), &shown).unwrap();
        assert_eq!(index(root, "f.txt"), "a\nB\nc\n");
        let staged = Shown { original: "a\nb\nc\n".into(), modified: "a\nB\nc\n".into() };
        apply_shown_lines(root, "f.txt", None, PatchOp::Unstage, &sel(&[(2, 2)], &[(2, 2)]), &staged).unwrap();
        assert_eq!(index(root, "f.txt"), "a\nb\nc\n");
    }
}
