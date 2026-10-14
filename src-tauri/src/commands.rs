use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::git::diff::FileVersions;
use crate::git::log::{CommitDetail, LogEntry};
use crate::git::refs::{Branch, Commit, OperationAction, Remote, ResetMode, Tag};
use crate::git::remote::RemoteOp;
use crate::git::repo::Identity;
use crate::git::stash::{StashEntry, StashMode};
use crate::git::status::Status;
use crate::git::{self, ops, GitError, GitResult, RepoInfo};
use crate::watcher::RepoWatcher;

/// Git calls block; run them off the main thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> GitResult<T> + Send + 'static) -> GitResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Err(GitError::new(e.to_string())))
}

/// The folder Grove was launched with (`grove .` or `grove C:\repo`), if any.
/// Relative paths are resolved against the launching shell's directory.
#[tauri::command]
pub fn launch_path() -> Option<String> {
    let arg = std::env::args().skip(1).find(|a| !a.starts_with('-'))?;
    let path = PathBuf::from(arg);
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    Some(path.to_string_lossy().into_owned())
}

/// Resolves `path` to its repository and starts watching it.
#[tauri::command]
pub async fn open_repo(app: AppHandle, watcher: State<'_, RepoWatcher>, path: String) -> GitResult<RepoInfo> {
    let info = blocking(move || git::repo_info(Path::new(&path))).await?;
    // The panel still works without live updates (F5 / window focus refresh).
    if let Err(e) = watcher.watch(app, PathBuf::from(&info.root)) {
        eprintln!("file watcher unavailable: {e}");
    }
    Ok(info)
}

#[tauri::command]
pub fn close_repo(watcher: State<'_, RepoWatcher>) {
    watcher.stop();
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
pub async fn remote_op(root: String, op: RemoteOp) -> GitResult<String> {
    blocking(move || git::remote::run_op(Path::new(&root), op)).await
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
pub async fn clone_repo(url: String, parent: String) -> GitResult<String> {
    blocking(move || git::repo::clone(&url, Path::new(&parent)).map(|p| p.to_string_lossy().into_owned())).await
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
