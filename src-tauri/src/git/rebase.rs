//! Interactive rebase, driven from Grove's editor instead of a text editor.
//!
//! Git still does all the work (`git rebase -i`); Grove only swaps in its own
//! todo list through `GIT_SEQUENCE_EDITOR`, which is a `cp` of a prepared
//! file. Git runs editor commands through its own `sh` (Git for Windows ships
//! one), so the same command works on Windows and macOS.
//!
//! New messages (reword, squash) are applied by `exec git commit --amend -F
//! <file>` lines placed after the commit they belong to, never through an
//! editor. Those lines live in git's own todo, so when the rebase stops for
//! `edit` or a conflict, Continue in the operation banner picks up exactly
//! where it left off and still applies the remaining messages.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{run, run_env, status, GitError, GitResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCommit {
    pub hash: String,
    pub short: String,
    pub subject: String,
    /// Full message, subject included.
    pub message: String,
    pub author: String,
    pub time: i64,
    /// Reachable from a remote-tracking branch, so rewriting it means a force push.
    pub pushed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlan {
    /// Full hash of the commit the rebased commits will sit on.
    pub base: String,
    pub base_short: String,
    /// True when the base isn't an ancestor of HEAD (e.g. another branch),
    /// so the commits also move onto it even if the list is left unchanged.
    pub moves: bool,
    /// Commits to rebase, oldest first (todo-list order).
    pub commits: Vec<PlanCommit>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Pick,
    Reword,
    Edit,
    Squash,
    Fixup,
    Drop,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub hash: String,
    pub action: Action,
    /// For a reword, the new message. For the first commit of a squash
    /// group, the combined message (a default is built when missing).
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RebaseState {
    /// Finished; the branch has been rewritten.
    Done,
    /// Paused on an `edit` commit.
    Edit,
    /// Paused on conflicts.
    Conflict,
    /// Paused for another reason (e.g. a failed message update), see `message`.
    Stopped,
}

#[derive(Debug, Serialize)]
pub struct RebaseOutcome {
    pub state: RebaseState,
    pub message: String,
}

/// Resolves a branch name or hash to a full commit hash.
fn resolve(root: &Path, rev: &str) -> GitResult<String> {
    let rev = rev.trim();
    if rev.is_empty() || rev.starts_with('-') {
        return Err(GitError::new("Choose a branch or commit to rebase onto."));
    }
    run(root, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")])
        .map(|h| h.trim().to_string())
        .map_err(|_| GitError::new(format!("\"{rev}\" isn't a commit or branch in this repository.")))
}

/// The commits `git rebase -i <base>` would replay, oldest first. Merge
/// commits are refused: replaying them needs `--rebase-merges`, whose todo
/// (labels, resets, merges) doesn't fit a simple reorderable list.
pub fn plan(root: &Path, base: &str) -> GitResult<RebasePlan> {
    if run(root, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
        return Err(GitError::new("There are no commits yet."));
    }
    let base = resolve(root, base)?;
    let range = format!("{base}..HEAD");

    let merges = run(root, &["rev-list", "--merges", "--abbrev-commit", &range])?;
    let merges: Vec<&str> = merges.lines().collect();
    if !merges.is_empty() {
        return Err(GitError::new(format!(
            "The commits to rebase include {} merge commit{} ({}). Interactive rebase in Grove only handles \
             straight history; start from a commit after the last merge, or use git rebase --rebase-merges in a terminal.",
            merges.len(),
            if merges.len() == 1 { "" } else { "s" },
            merges.join(", "),
        )));
    }

    let unpushed: HashSet<String> =
        run(root, &["rev-list", &range, "--not", "--remotes"])?.lines().map(str::to_string).collect();
    let out = run(root, &["log", "--reverse", "--format=%x1e%H%x00%h%x00%an%x00%at%x00%B", &range])?;
    let commits: Vec<PlanCommit> = out
        .split('\u{1e}')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.splitn(5, '\0').collect();
            (f.len() == 5).then(|| {
                let message = f[4].trim_end().to_string();
                PlanCommit {
                    hash: f[0].to_string(),
                    short: f[1].to_string(),
                    subject: message.lines().next().unwrap_or("").to_string(),
                    author: f[2].to_string(),
                    time: f[3].parse().unwrap_or(0),
                    pushed: !unpushed.contains(f[0]),
                    message,
                }
            })
        })
        .collect();

    let base_short = run(root, &["rev-parse", "--short", &base])?.trim().to_string();
    if commits.is_empty() {
        return Err(GitError::new(format!("There are no commits after {base_short} on this branch to rebase.")));
    }
    let moves = run(root, &["merge-base", "--is-ancestor", &base, "HEAD"]).is_err();
    Ok(RebasePlan { base, base_short, moves, commits })
}

/// Quotes `s` for the POSIX shell git runs editor and exec commands with.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Forward slashes work for git, Git for Windows' sh and macOS alike, and
/// avoid backslashes being read as escapes.
fn shell_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

struct Group {
    head: usize,
    has_squash: bool,
}

/// Turns the user's steps into a git todo list plus the message files its
/// `exec` lines read. Every planned commit must appear exactly once, so a
/// stale or partial plan can never silently lose commits.
fn build_todo(plan: &RebasePlan, steps: &[Step], dir: &Path) -> GitResult<(String, Vec<(PathBuf, String)>)> {
    let messages: HashMap<&str, &str> = plan.commits.iter().map(|c| (c.hash.as_str(), c.message.as_str())).collect();
    let mut seen = HashSet::new();
    for s in steps {
        if !messages.contains_key(s.hash.as_str()) || !seen.insert(s.hash.as_str()) {
            return Err(GitError::new("The rebase plan is out of date. Reopen the interactive rebase and try again."));
        }
    }
    if seen.len() != plan.commits.len() {
        return Err(GitError::new("The rebase plan is out of date. Reopen the interactive rebase and try again."));
    }

    let mut lines = Vec::new();
    let mut files = Vec::new();
    let mut group: Option<Group> = None;

    let mut close = |group: Option<Group>, lines: &mut Vec<String>| -> GitResult<()> {
        let Some(g) = group else { return Ok(()) };
        let head = &steps[g.head];
        if head.action != Action::Reword && !g.has_squash {
            return Ok(());
        }
        let custom = head.message.as_deref().map(str::trim).filter(|m| !m.is_empty());
        let message = match custom {
            Some(m) => m.to_string(),
            None if head.action == Action::Reword => {
                return Err(GitError::new("Enter a message for each commit you reword."));
            }
            // Same default git offers: all squashed messages, in order.
            None => steps[g.head..]
                .iter()
                .take_while(|s| s.hash == head.hash || matches!(s.action, Action::Squash | Action::Fixup | Action::Drop))
                .filter(|s| s.hash == head.hash || s.action == Action::Squash)
                .map(|s| messages[s.hash.as_str()].trim())
                .collect::<Vec<_>>()
                .join("\n\n"),
        };
        let path = dir.join(format!("msg-{}", files.len() + 1));
        lines.push(format!(
            "exec git commit --amend --allow-empty --no-verify --quiet -F {}",
            sh_quote(&shell_path(&path))
        ));
        files.push((path, message + "\n"));
        Ok(())
    };

    for (i, s) in steps.iter().enumerate() {
        match s.action {
            Action::Drop => lines.push(format!("drop {}", s.hash)),
            Action::Squash | Action::Fixup => {
                let Some(g) = group.as_mut() else {
                    return Err(GitError::new(
                        "The first commit can't be squashed or fixed up; there's no earlier commit in the list to combine it with.",
                    ));
                };
                g.has_squash |= s.action == Action::Squash;
                // The combined message is applied by an exec line, so git
                // never needs an editor for it.
                lines.push(format!("fixup {}", s.hash));
            }
            Action::Pick | Action::Reword | Action::Edit => {
                close(group.take(), &mut lines)?;
                let cmd = if s.action == Action::Edit { "edit" } else { "pick" };
                lines.push(format!("{cmd} {}", s.hash));
                group = Some(Group { head: i, has_squash: false });
            }
        }
    }
    close(group.take(), &mut lines)?;
    drop(close);
    lines.push(String::new());
    Ok((lines.join("\n"), files))
}

/// Where Grove keeps its todo and message files: inside the git directory,
/// because they must outlive this call when the rebase stops.
fn work_dir(root: &Path) -> GitResult<PathBuf> {
    let rel = run(root, &["rev-parse", "--git-path", "grove-rebase"])?;
    Ok(root.join(rel.trim()))
}

fn tracked_changes(root: &Path) -> GitResult<bool> {
    Ok(!run(root, &["status", "--porcelain", "--untracked-files=no"])?.trim().is_empty())
}

pub fn start(root: &Path, base: &str, steps: &[Step], autostash: bool) -> GitResult<RebaseOutcome> {
    let st = status::status(root)?;
    if let Some(op) = &st.operation {
        return Err(GitError::new(format!("A {op} is already in progress. Finish or abort it first.")));
    }
    if st.branch.is_none() {
        return Err(GitError::new("HEAD is detached. Check out a branch before rebasing."));
    }
    if !autostash && tracked_changes(root)? {
        return Err(GitError::new(
            "You have uncommitted changes. Commit or stash them first, or let Grove stash them during the rebase.",
        ));
    }

    let plan = plan(root, base)?;
    let dir = work_dir(root)?;
    let (todo, files) = build_todo(&plan, steps, &dir)?;
    let io = |e: std::io::Error| GitError::new(format!("couldn't prepare the rebase: {e}"));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(io)?;
    }
    std::fs::create_dir_all(&dir).map_err(io)?;
    let todo_path = dir.join("todo");
    std::fs::write(&todo_path, &todo).map_err(io)?;
    for (path, message) in &files {
        std::fs::write(path, message).map_err(io)?;
    }

    let sequence_editor = format!("cp {}", sh_quote(&shell_path(&todo_path)));
    let result = run_env(
        root,
        &[
            // Settings that would add lines our todo doesn't have.
            "-c",
            "rebase.updateRefs=false",
            "-c",
            "rebase.rebaseMerges=false",
            "rebase",
            "-i",
            "--no-autosquash",
            // A commit whose changes are already in the base would otherwise
            // stop the rebase and ask what to do.
            "--empty=drop",
            if autostash { "--autostash" } else { "--no-autostash" },
            &plan.base,
        ],
        &[("GIT_SEQUENCE_EDITOR", sequence_editor.as_str()), ("GIT_EDITOR", "true")],
    );

    let after = status::status(root)?;
    if after.operation.as_deref() != Some("rebase") {
        let _ = std::fs::remove_dir_all(&dir);
        result?;
        let kept = steps.iter().filter(|s| !matches!(s.action, Action::Drop | Action::Squash | Action::Fixup)).count();
        return Ok(RebaseOutcome {
            state: RebaseState::Done,
            message: format!(
                "Rebased onto {}: {kept} commit{}.",
                plan.base_short,
                if kept == 1 { "" } else { "s" }
            ),
        });
    }

    if !after.conflicts.is_empty() {
        let n = after.conflicts.len();
        return Ok(RebaseOutcome {
            state: RebaseState::Conflict,
            message: format!(
                "Rebase stopped on conflicts in {n} file{}. Resolve and stage them, then Continue (or Abort).",
                if n == 1 { "" } else { "s" }
            ),
        });
    }
    match result {
        Ok(_) => {
            let head = run(root, &["log", "-1", "--format=%h %s"]).unwrap_or_default();
            Ok(RebaseOutcome {
                state: RebaseState::Edit,
                message: format!("Stopped at {} for editing. Make your changes, then Continue.", head.trim()),
            })
        }
        Err(e) => Ok(RebaseOutcome {
            state: RebaseState::Stopped,
            message: format!("Rebase paused: {}", e.message),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::refs::{operation, OperationAction};

    /// A repo whose path has a space and a quote, to prove the shell quoting.
    struct Repo {
        _dir: tempfile::TempDir,
        root: PathBuf,
    }

    fn repo() -> Repo {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("it's a repo");
        std::fs::create_dir(&root).unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "T"],
            &["config", "commit.gpgsign", "false"],
            &["config", "core.autocrlf", "false"],
        ] {
            run(&root, args).unwrap();
        }
        commit_file(&root, "base.txt", "base\n", "base");
        Repo { _dir: dir, root }
    }

    fn commit_file(root: &Path, name: &str, content: &str, msg: &str) {
        std::fs::write(root.join(name), content).unwrap();
        run(root, &["add", name]).unwrap();
        run(root, &["commit", "-qm", msg]).unwrap();
    }

    /// base, then commits a, b, c each adding their own file.
    fn abc() -> (Repo, RebasePlan) {
        let r = repo();
        for n in ["a", "b", "c"] {
            commit_file(&r.root, &format!("{n}.txt"), n, n);
        }
        let p = plan(&r.root, "HEAD~3").unwrap();
        (r, p)
    }

    fn step(p: &RebasePlan, i: usize, action: Action, message: Option<&str>) -> Step {
        Step { hash: p.commits[i].hash.clone(), action, message: message.map(str::to_string) }
    }

    fn subjects(root: &Path) -> Vec<String> {
        run(root, &["log", "--format=%s"]).unwrap().lines().map(str::to_string).collect()
    }

    fn head_message(root: &Path) -> String {
        run(root, &["log", "-1", "--format=%B"]).unwrap().trim_end().to_string()
    }

    #[test]
    fn plan_lists_commits_oldest_first() {
        let (r, p) = abc();
        assert_eq!(p.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
        assert!(p.commits.iter().all(|c| !c.pushed));
        assert!(!p.moves);

        // "a" is on a remote-tracking branch, so it counts as pushed.
        run(&r.root, &["update-ref", "refs/remotes/origin/main", "HEAD~2"]).unwrap();
        let p = plan(&r.root, "HEAD~3").unwrap();
        assert_eq!(p.commits.iter().map(|c| c.pushed).collect::<Vec<_>>(), [true, false, false]);
        assert_eq!(p.commits[0].message, "a");

        run(&r.root, &["branch", "other", "HEAD~3"]).unwrap();
        run(&r.root, &["switch", "-q", "other"]).unwrap();
        commit_file(&r.root, "o.txt", "o", "o");
        run(&r.root, &["switch", "-q", "main"]).unwrap();
        let onto = plan(&r.root, "other").unwrap();
        assert!(onto.moves);
        assert_eq!(onto.commits.len(), 3);
        assert!(plan(&r.root, "HEAD").is_err(), "nothing to rebase");
        assert!(plan(&r.root, "--all").is_err());
        assert!(plan(&r.root, "nope").is_err());
    }

    #[test]
    fn reorder() {
        let (r, p) = abc();
        let steps = [step(&p, 2, Action::Pick, None), step(&p, 0, Action::Pick, None), step(&p, 1, Action::Pick, None)];
        let out = start(&r.root, &p.base, &steps, false).unwrap();
        assert_eq!(out.state, RebaseState::Done);
        assert_eq!(subjects(&r.root), ["b", "a", "c", "base"]);
        assert!(!work_dir(&r.root).unwrap().exists(), "temp files cleaned up");
    }

    #[test]
    fn drop_commit() {
        let (r, p) = abc();
        let steps = [step(&p, 0, Action::Pick, None), step(&p, 1, Action::Drop, None), step(&p, 2, Action::Pick, None)];
        start(&r.root, &p.base, &steps, false).unwrap();
        assert_eq!(subjects(&r.root), ["c", "a", "base"]);
        assert!(!r.root.join("b.txt").exists());
    }

    #[test]
    fn drop_everything() {
        let (r, p) = abc();
        let steps: Vec<_> = (0..3).map(|i| step(&p, i, Action::Drop, None)).collect();
        let out = start(&r.root, &p.base, &steps, false).unwrap();
        assert_eq!(out.state, RebaseState::Done);
        assert_eq!(subjects(&r.root), ["base"]);
    }

    #[test]
    fn squash_with_custom_message() {
        let (r, p) = abc();
        let steps = [
            step(&p, 0, Action::Pick, Some("a and b\n\nCombined.")),
            step(&p, 1, Action::Squash, None),
            step(&p, 2, Action::Pick, None),
        ];
        start(&r.root, &p.base, &steps, false).unwrap();
        assert_eq!(subjects(&r.root), ["c", "a and b", "base"]);
        assert_eq!(run(&r.root, &["log", "-1", "--format=%B", "HEAD~1"]).unwrap().trim_end(), "a and b\n\nCombined.");
        assert!(r.root.join("b.txt").exists());
    }

    #[test]
    fn squash_default_message_combines() {
        let (r, p) = abc();
        let steps = [step(&p, 0, Action::Pick, None), step(&p, 1, Action::Fixup, None), step(&p, 2, Action::Squash, None)];
        start(&r.root, &p.base, &steps, false).unwrap();
        assert_eq!(head_message(&r.root), "a\n\nc");
    }

    #[test]
    fn reword() {
        let (r, p) = abc();
        let steps = [
            step(&p, 0, Action::Pick, None),
            step(&p, 1, Action::Reword, Some("b, reworded\n\nIt's got a body with \"quotes\" and $vars.")),
            step(&p, 2, Action::Pick, None),
        ];
        start(&r.root, &p.base, &steps, false).unwrap();
        assert_eq!(subjects(&r.root), ["c", "b, reworded", "a", "base"]);
        assert_eq!(
            run(&r.root, &["log", "-1", "--format=%B", "HEAD~1"]).unwrap().trim_end(),
            "b, reworded\n\nIt's got a body with \"quotes\" and $vars."
        );
        assert!(start(&r.root, &p.base, &steps, false).is_err(), "plan is stale after rewriting");
        let p = plan(&r.root, "HEAD~3").unwrap();
        let missing = [step(&p, 0, Action::Reword, Some("  ")), step(&p, 1, Action::Pick, None), step(&p, 2, Action::Pick, None)];
        let err = start(&r.root, &p.base, &missing, false).unwrap_err();
        assert!(err.message.contains("message"), "{}", err.message);
    }

    #[test]
    fn fixup_keeps_first_message() {
        let (r, p) = abc();
        let steps = [step(&p, 0, Action::Pick, None), step(&p, 1, Action::Pick, None), step(&p, 2, Action::Fixup, None)];
        start(&r.root, &p.base, &steps, false).unwrap();
        assert_eq!(subjects(&r.root), ["b", "a", "base"]);
        assert!(r.root.join("c.txt").exists());
    }

    #[test]
    fn edit_stop_then_continue() {
        let (r, p) = abc();
        let steps = [
            step(&p, 0, Action::Edit, None),
            step(&p, 1, Action::Reword, Some("b2")),
            step(&p, 2, Action::Pick, None),
        ];
        let out = start(&r.root, &p.base, &steps, false).unwrap();
        assert_eq!(out.state, RebaseState::Edit, "{}", out.message);
        assert_eq!(status::status(&r.root).unwrap().operation.as_deref(), Some("rebase"));
        assert_eq!(head_message(&r.root), "a");

        // Amend the stopped commit the way the UI would: stage, then Continue.
        std::fs::write(r.root.join("a.txt"), "a, edited").unwrap();
        run(&r.root, &["add", "a.txt"]).unwrap();
        operation(&r.root, "rebase", OperationAction::Continue).unwrap();

        assert_eq!(status::status(&r.root).unwrap().operation, None);
        assert_eq!(subjects(&r.root), ["c", "b2", "a", "base"]);
        let a = run(&r.root, &["show", "HEAD~2:a.txt"]).unwrap();
        assert_eq!(a, "a, edited");
    }

    #[test]
    fn conflict_stop_then_abort() {
        let r = repo();
        commit_file(&r.root, "f.txt", "one\n", "one");
        commit_file(&r.root, "f.txt", "two\n", "two");
        let before = run(&r.root, &["rev-parse", "HEAD"]).unwrap();
        let p = plan(&r.root, "HEAD~2").unwrap();
        // Applying "two" before "one" can't work: it edits a file that doesn't exist yet.
        let steps = [step(&p, 1, Action::Pick, None), step(&p, 0, Action::Pick, None)];
        let out = start(&r.root, &p.base, &steps, false).unwrap();
        assert_eq!(out.state, RebaseState::Conflict, "{}", out.message);
        assert!(!status::status(&r.root).unwrap().conflicts.is_empty());

        operation(&r.root, "rebase", OperationAction::Abort).unwrap();
        assert_eq!(status::status(&r.root).unwrap().operation, None);
        assert_eq!(run(&r.root, &["rev-parse", "HEAD"]).unwrap(), before);
    }

    #[test]
    fn refusals_and_autostash() {
        let (r, p) = abc();
        let picks: Vec<_> = (0..3).map(|i| step(&p, i, Action::Pick, None)).collect();

        let bad = [step(&p, 0, Action::Squash, None), step(&p, 1, Action::Pick, None), step(&p, 2, Action::Pick, None)];
        assert!(start(&r.root, &p.base, &bad, false).is_err(), "first can't be squash");
        let after_drop = [step(&p, 0, Action::Drop, None), step(&p, 1, Action::Fixup, None), step(&p, 2, Action::Pick, None)];
        assert!(start(&r.root, &p.base, &after_drop, false).is_err(), "first kept can't be fixup");
        assert!(start(&r.root, &p.base, &picks[..2], false).is_err(), "missing commit");

        std::fs::write(r.root.join("a.txt"), "dirty").unwrap();
        let err = start(&r.root, &p.base, &picks, false).unwrap_err();
        assert!(err.message.contains("uncommitted"), "{}", err.message);
        let reorder = [step(&p, 1, Action::Pick, None), step(&p, 0, Action::Pick, None), step(&p, 2, Action::Pick, None)];
        assert_eq!(start(&r.root, &p.base, &reorder, true).unwrap().state, RebaseState::Done);
        assert_eq!(subjects(&r.root), ["c", "a", "b", "base"]);
        assert_eq!(std::fs::read_to_string(r.root.join("a.txt")).unwrap(), "dirty", "autostash restored");
        run(&r.root, &["checkout", "--", "a.txt"]).unwrap();

        let head = run(&r.root, &["rev-parse", "HEAD"]).unwrap();
        run(&r.root, &["switch", "-q", "--detach", head.trim()]).unwrap();
        let p2 = plan(&r.root, "HEAD~1").unwrap();
        let err = start(&r.root, &p2.base, &[step(&p2, 0, Action::Pick, None)], false).unwrap_err();
        assert!(err.message.contains("detached"), "{}", err.message);
    }

    #[test]
    fn merges_are_refused() {
        let r = repo();
        run(&r.root, &["switch", "-qc", "side"]).unwrap();
        commit_file(&r.root, "s.txt", "s", "side");
        run(&r.root, &["switch", "-q", "main"]).unwrap();
        commit_file(&r.root, "m.txt", "m", "main");
        run(&r.root, &["merge", "-q", "--no-edit", "side"]).unwrap();
        let err = plan(&r.root, "HEAD~2").unwrap_err();
        assert!(err.message.contains("merge commit"), "{}", err.message);
    }
}
