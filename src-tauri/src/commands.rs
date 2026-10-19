use std::path::{Path, PathBuf};

use tauri::{AppHandle, State, WebviewWindow};

use crate::git::diff::FileVersions;
use crate::git::log::{CommitDetail, LogEntry};
use crate::git::refs::{Branch, Commit, OperationAction, Remote, ResetMode, Tag};
use crate::git::remote::RemoteOp;
use crate::git::repo::Identity;
use crate::git::stash::{StashEntry, StashMode};
use crate::git::status::Status;
use crate::git::{self, ops, GitError, GitResult, RepoInfo};
use crate::watcher::RepoWatcher;
// Credential prompts, progress & cancel.
use crate::askpass;
use crate::git::stream::{Op, Progress};
use tauri::{Emitter, EventTarget, Manager};

/// Git calls block; run them off the main thread.
pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> GitResult<T> + Send + 'static) -> GitResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Err(GitError::new(e.to_string())))
}

/// The folder Grove was launched with (`grove .` or `grove C:\repo`), if any.
/// Relative paths are resolved against the launching shell's directory.
#[tauri::command]
pub fn launch_path() -> Option<String> {
    let arg = std::env::args().skip(1).find(|a| !a.starts_with('-'))?;
    let path = PathBuf::from(unmangle_trailing_quote(arg));
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    Some(path.to_string_lossy().into_owned())
}

/// Explorer's "Open in Grove" passes `"%V"`, which for a drive root is
/// `"C:\"`; Windows reads `\"` as an escaped quote, so the argument arrives
/// as `C:"`. File names can't contain `"`, so a trailing one is that
/// backslash.
fn unmangle_trailing_quote(arg: String) -> String {
    match arg.strip_suffix('"') {
        Some(rest) if cfg!(windows) => format!("{rest}\\"),
        _ => arg,
    }
}

/// Resolves `path` to its repository and starts watching it for the
/// calling window (each window has its own repo and watch).
#[tauri::command]
pub async fn open_repo(
    app: AppHandle,
    window: WebviewWindow,
    watcher: State<'_, RepoWatcher>,
    path: String,
) -> GitResult<RepoInfo> {
    let (info, dirs) = blocking(move || {
        let info = git::repo_info(Path::new(&path))?;
        let dirs = git::git_dirs(Path::new(&info.root));
        Ok((info, dirs))
    })
    .await?;
    // The panel still works without live updates (F5 / window focus refresh).
    let watched = dirs
        .map_err(|e| e.message)
        .and_then(|(own, common)| watcher.watch(app, window.label(), PathBuf::from(&info.root), own, common));
    if let Err(e) = watched {
        eprintln!("file watcher unavailable: {e}");
    }
    Ok(info)
}

#[tauri::command]
pub fn close_repo(window: WebviewWindow, watcher: State<'_, RepoWatcher>) {
    watcher.stop(window.label());
}

#[tauri::command]
pub async fn status(root: String) -> GitResult<Status> {
    blocking(move || git::status::status(Path::new(&root))).await
}

#[tauri::command]
pub async fn stage(root: String, paths: Vec<String>) -> GitResult<()> {
    blocking(move || ops::stage(Path::new(&root), &paths)).await
}

#[tauri::command]
pub async fn unstage(root: String, paths: Vec<String>) -> GitResult<()> {
    blocking(move || ops::unstage(Path::new(&root), &paths)).await
}

#[tauri::command]
pub async fn unstage_all(root: String) -> GitResult<()> {
    blocking(move || ops::unstage_all(Path::new(&root))).await
}

#[tauri::command]
pub async fn discard(root: String, tracked: Vec<String>, untracked: Vec<String>) -> GitResult<()> {
    blocking(move || ops::discard(Path::new(&root), &tracked, &untracked)).await
}

#[tauri::command]
pub async fn file_versions(
    root: String,
    group: String,
    path: String,
    from: Option<String>,
    rev: Option<String>,
) -> GitResult<FileVersions> {
    blocking(move || git::diff::versions(Path::new(&root), &group, &path, from.as_deref(), rev.as_deref()))
    .await
}

#[tauri::command]
pub async fn commit(root: String, message: String, amend: bool) -> GitResult<String> {
    blocking(move || git::commit::commit(Path::new(&root), &message, amend)).await
}

#[tauri::command]
pub async fn last_commit_message(root: String) -> GitResult<Option<String>> {
    blocking(move || git::commit::last_message(Path::new(&root))).await
}

#[tauri::command]
pub async fn undo_last_commit(root: String) -> GitResult<String> {
    blocking(move || git::commit::undo_last(Path::new(&root))).await
}

#[tauri::command]
pub async fn remote_op(window: WebviewWindow, root: String, op: RemoteOp) -> GitResult<String> {
    network(window, move |net| git::remote::run_op_with(Path::new(&root), op, net)).await
}

#[tauri::command]
pub async fn stash_list(root: String) -> GitResult<Vec<StashEntry>> {
    blocking(move || git::stash::list(Path::new(&root))).await
}

#[tauri::command]
pub async fn stash_push(root: String, message: String, mode: StashMode) -> GitResult<()> {
    blocking(move || git::stash::push(Path::new(&root), &message, mode)).await
}

#[tauri::command]
pub async fn stash_apply(root: String, stash_ref: String, pop: bool) -> GitResult<()> {
    blocking(move || git::stash::apply(Path::new(&root), &stash_ref, pop)).await
}

#[tauri::command]
pub async fn stash_drop(root: String, stash_ref: String) -> GitResult<()> {
    blocking(move || git::stash::drop_stash(Path::new(&root), &stash_ref)).await
}

// Branches, tags, remotes, history operations. Thin wrappers over git::refs.

#[tauri::command]
pub async fn branches(root: String) -> GitResult<Vec<Branch>> {
    blocking(move || git::refs::branches(Path::new(&root))).await
}

#[tauri::command]
pub async fn checkout(root: String, name: String, remote: bool) -> GitResult<String> {
    blocking(move || git::refs::checkout(Path::new(&root), &name, remote)).await
}

#[tauri::command]
pub async fn create_branch(root: String, name: String, start: Option<String>, switch: bool) -> GitResult<()> {
    blocking(move || git::refs::create_branch(Path::new(&root), &name, start.as_deref(), switch)).await
}

#[tauri::command]
pub async fn rename_branch(root: String, old: String, new: String) -> GitResult<()> {
    blocking(move || git::refs::rename_branch(Path::new(&root), &old, &new)).await
}

#[tauri::command]
pub async fn delete_branch(root: String, name: String, force: bool) -> GitResult<()> {
    blocking(move || git::refs::delete_branch(Path::new(&root), &name, force)).await
}

#[tauri::command]
pub async fn merge(root: String, name: String) -> GitResult<String> {
    blocking(move || git::refs::merge(Path::new(&root), &name)).await
}

#[tauri::command]
pub async fn rebase(root: String, onto: String) -> GitResult<String> {
    blocking(move || git::refs::rebase(Path::new(&root), &onto)).await
}

#[tauri::command]
pub async fn operation(root: String, kind: String, action: OperationAction) -> GitResult<()> {
    blocking(move || git::refs::operation(Path::new(&root), &kind, action)).await
}

#[tauri::command]
pub async fn tags(root: String) -> GitResult<Vec<Tag>> {
    blocking(move || git::refs::tags(Path::new(&root))).await
}

#[tauri::command]
pub async fn create_tag(root: String, name: String, message: String, target: Option<String>) -> GitResult<()> {
    blocking(move || git::refs::create_tag(Path::new(&root), &name, &message, target.as_deref())).await
}

#[tauri::command]
pub async fn delete_tag(root: String, name: String) -> GitResult<()> {
    blocking(move || git::refs::delete_tag(Path::new(&root), &name)).await
}

#[tauri::command]
pub async fn remotes(root: String) -> GitResult<Vec<Remote>> {
    blocking(move || git::refs::remotes(Path::new(&root))).await
}

#[tauri::command]
pub async fn add_remote(root: String, name: String, url: String) -> GitResult<()> {
    blocking(move || git::refs::add_remote(Path::new(&root), &name, &url)).await
}

#[tauri::command]
pub async fn remove_remote(root: String, name: String) -> GitResult<()> {
    blocking(move || git::refs::remove_remote(Path::new(&root), &name)).await
}

#[tauri::command]
pub async fn reset(root: String, target: String, mode: ResetMode) -> GitResult<()> {
    blocking(move || git::refs::reset(Path::new(&root), &target, mode)).await
}

#[tauri::command]
pub async fn clean(root: String) -> GitResult<usize> {
    blocking(move || git::refs::clean(Path::new(&root))).await
}

#[tauri::command]
pub async fn recent_commits(root: String, limit: usize) -> GitResult<Vec<Commit>> {
    blocking(move || git::refs::recent_commits(Path::new(&root), limit)).await
}

#[tauri::command]
pub async fn log(root: String, skip: usize, limit: usize, all: bool) -> GitResult<Vec<LogEntry>> {
    blocking(move || git::log::log(Path::new(&root), skip, limit, all)).await
}

#[tauri::command]
pub async fn commit_detail(root: String, hash: String) -> GitResult<CommitDetail> {
    blocking(move || git::log::detail(Path::new(&root), &hash)).await
}

#[tauri::command]
pub async fn cherry_pick(root: String, hash: String) -> GitResult<()> {
    blocking(move || git::log::cherry_pick(Path::new(&root), &hash)).await
}

#[tauri::command]
pub async fn revert(root: String, hash: String) -> GitResult<()> {
    blocking(move || git::log::revert(Path::new(&root), &hash)).await
}

#[tauri::command]
pub async fn checkout_detached(root: String, hash: String) -> GitResult<()> {
    blocking(move || git::log::checkout_detached(Path::new(&root), &hash)).await
}

// Repository setup, identity, and OS integration.

#[tauri::command]
pub async fn clone_repo(window: WebviewWindow, url: String, parent: String) -> GitResult<String> {
    network(window, move |net| {
        git::repo::clone_with(&url, Path::new(&parent), net).map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
pub async fn init_repo(path: String) -> GitResult<()> {
    blocking(move || git::repo::init(Path::new(&path))).await
}

#[tauri::command]
pub async fn identity(root: String) -> GitResult<Identity> {
    blocking(move || Ok(git::repo::identity(Path::new(&root)))).await
}

#[tauri::command]
pub async fn set_identity(root: String, name: String, email: String, global: bool) -> GitResult<()> {
    blocking(move || git::repo::set_identity(Path::new(&root), &name, &email, global)).await
}

#[tauri::command]
pub fn open_folder(app: AppHandle, path: String) -> GitResult<()> {
    crate::system::open_folder(&app, Path::new(&path))
}

#[tauri::command]
pub fn open_terminal(path: String) -> GitResult<()> {
    crate::system::open_terminal(Path::new(&path))
}

#[tauri::command]
pub fn open_repo_file(app: AppHandle, root: String, path: String, create: bool) -> GitResult<()> {
    crate::system::open_repo_file(&app, Path::new(&root), &path, create)
}

// File history and blame.

#[tauri::command]
pub async fn file_log(root: String, path: String, skip: usize, limit: usize) -> GitResult<Vec<git::file_log::FileLogEntry>> {
    blocking(move || git::file_log::file_log(Path::new(&root), &path, skip, limit)).await
}

/// `rev` is `None` for the working tree, else `HEAD` or a commit hash.
#[tauri::command]
pub async fn blame(root: String, path: String, rev: Option<String>) -> GitResult<git::blame::Blame> {
    blocking(move || git::blame::blame(Path::new(&root), &path, rev.as_deref())).await
}

// File panel context menu: .gitignore, conflict sides, stash branch, OS hand-offs.

#[tauri::command]
pub async fn gitignore_add(root: String, patterns: Vec<String>) -> GitResult<usize> {
    blocking(move || git::files::add_to_gitignore(Path::new(&root), &patterns)).await
}

#[tauri::command]
pub async fn take_side(root: String, paths: Vec<String>, side: git::files::Side) -> GitResult<()> {
    blocking(move || git::files::take_side(Path::new(&root), &paths, side)).await
}

#[tauri::command]
pub async fn stash_branch(root: String, name: String, stash_ref: String) -> GitResult<()> {
    blocking(move || git::files::stash_branch(Path::new(&root), &name, &stash_ref)).await
}

#[tauri::command]
pub fn reveal_repo_file(app: AppHandle, root: String, path: String) -> GitResult<()> {
    crate::system::reveal_repo_file(&app, Path::new(&root), &path)
}

#[tauri::command]
pub fn open_in_editor(app: AppHandle, root: String, paths: Vec<String>) -> GitResult<bool> {
    crate::system::open_in_editor(&app, Path::new(&root), &paths)
}

// ---- Credential prompts, progress & cancel ----

/// Runs a network operation off the main thread with credential prompts,
/// `git-progress` events and cancel support, all scoped to `window`.
/// `git-progress-end` always follows so the UI can drop the progress bar.
pub(crate) async fn network<T: Send + 'static>(
    window: WebviewWindow,
    f: impl FnOnce(&Op) -> GitResult<T> + Send + 'static,
) -> GitResult<T> {
    start_askpass(window.app_handle());
    let label = window.label().to_string();
    let done = window.clone();
    let result = blocking(move || {
        let _ = window.emit_to(here(&label), "git-progress", Progress { phase: "Connecting".into(), percent: None });
        let net = Op::new(&label, {
            let label = label.clone();
            move |p| {
                let _ = window.emit_to(here(&label), "git-progress", p);
            }
        });
        f(&net)
    })
    .await;
    let _ = done.emit_to(here(done.label()), "git-progress-end", ());
    result
}

fn here(label: &str) -> EventTarget {
    EventTarget::webview_window(label)
}

fn start_askpass(app: &AppHandle) {
    let (show, close) = (app.clone(), app.clone());
    askpass::ensure_started(
        move |prompt| {
            let _ = show.emit_to(here(&prompt.window), "askpass", prompt);
        },
        move |id, window| {
            let _ = close.emit_to(here(window), "askpass-closed", id);
        },
    );
}

/// The Cancel button: kills this window's network operations and closes any
/// credential prompt they were waiting on.
#[tauri::command]
pub fn cancel_git(window: WebviewWindow) {
    git::stream::cancel_window(window.label());
    if let Some(server) = askpass::global() {
        server.cancel_window(window.label());
    }
}

/// The user's answer to a credential prompt (None = cancelled).
#[tauri::command]
pub fn askpass_answer(id: u64, answer: Option<String>) {
    if let Some(server) = askpass::global() {
        server.answer(id, answer);
    }
}

// Interactive rebase.

#[tauri::command]
pub async fn rebase_plan(root: String, base: String) -> GitResult<git::rebase::RebasePlan> {
    blocking(move || git::rebase::plan(Path::new(&root), &base)).await
}

#[tauri::command]
pub async fn start_interactive_rebase(
    root: String,
    base: String,
    steps: Vec<git::rebase::Step>,
    autostash: bool,
) -> GitResult<git::rebase::RebaseOutcome> {
    blocking(move || git::rebase::start(Path::new(&root), &base, &steps, autostash)).await
}

// Merge conflict editor.

#[tauri::command]
pub async fn conflict_file(root: String, path: String) -> GitResult<git::conflict::ConflictFile> {
    blocking(move || git::conflict::read(Path::new(&root), &path)).await
}

#[tauri::command]
pub async fn save_conflict(root: String, path: String, content: String, stage: bool) -> GitResult<()> {
    blocking(move || git::conflict::save(Path::new(&root), &path, &content, stage)).await
}

#[tauri::command]
pub async fn resolve_conflict(root: String, path: String, resolution: git::conflict::Resolution) -> GitResult<()> {
    blocking(move || git::conflict::resolve(Path::new(&root), &path, resolution)).await
}

// History search and comparing refs.

#[tauri::command]
pub async fn search_log(root: String, query: git::search::LogQuery) -> GitResult<Vec<LogEntry>> {
    blocking(move || git::search::search(Path::new(&root), &query)).await
}

/// `b` of `None` compares with the working tree.
#[tauri::command]
pub async fn compare(root: String, a: String, b: Option<String>, three_dot: bool) -> GitResult<git::compare::Comparison> {
    blocking(move || git::compare::compare(Path::new(&root), &a, b.as_deref(), three_dot)).await
}

#[tauri::command]
pub async fn ref_versions(
    root: String,
    base: String,
    head: Option<String>,
    path: String,
    from: Option<String>,
) -> GitResult<FileVersions> {
    blocking(move || git::compare::ref_versions(Path::new(&root), &base, head.as_deref(), &path, from.as_deref()))
        .await
}

// Partial staging (hunks and lines).

#[tauri::command]
pub async fn apply_lines(
    root: String,
    path: String,
    from: Option<String>,
    op: git::patch::PatchOp,
    lines: git::patch::LineSelection,
    shown: git::patch::Shown,
) -> GitResult<()> {
    blocking(move || git::patch::apply_shown_lines(Path::new(&root), &path, from.as_deref(), op, &lines, &shown)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairs_a_quoted_drive_root() {
        let fixed = unmangle_trailing_quote("C:\"".into());
        assert_eq!(fixed, if cfg!(windows) { "C:\\" } else { "C:\"" });
        assert_eq!(unmangle_trailing_quote("C:\repo".into()), "C:\repo");
    }
}
