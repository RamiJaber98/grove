use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::git::diff::FileVersions;
use crate::git::remote::RemoteOp;
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
    stash_ref: Option<String>,
) -> GitResult<FileVersions> {
    blocking(move || {
        git::diff::versions(Path::new(&root), &group, &path, from.as_deref(), stash_ref.as_deref())
    })
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
