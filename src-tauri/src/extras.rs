//! Commands for the less common features: image diffs, remote branches,
//! submodules, worktrees, LFS and extra windows. Thin wrappers like the ones
//! in commands.rs.

use std::path::Path;

use tauri::{AppHandle, WebviewWindow};

use crate::commands::{blocking, network};
use crate::git::image::ImageVersions;
use crate::git::lfs::LfsInfo;
use crate::git::submodule::{Submodule, SubmoduleDiff};
use crate::git::worktree::Worktree;
use crate::git::{self, GitResult};

#[tauri::command]
pub async fn image_versions(
    root: String,
    group: String,
    path: String,
    from: Option<String>,
    rev: Option<String>,
) -> GitResult<ImageVersions> {
    blocking(move || git::image::versions(Path::new(&root), &group, &path, from.as_deref(), rev.as_deref())).await
}

#[tauri::command]
pub async fn delete_remote_branch(window: WebviewWindow, root: String, name: String) -> GitResult<String> {
    network(window, move |net| git::remote_branch::delete_remote_branch(Path::new(&root), &name, net)).await
}

#[tauri::command]
pub async fn publish_branch(window: WebviewWindow, root: String, remote: String) -> GitResult<String> {
    network(window, move |net| git::remote_branch::publish_branch(Path::new(&root), &remote, net)).await
}

#[tauri::command]
pub async fn set_upstream(root: String, upstream: String) -> GitResult<String> {
    blocking(move || git::remote_branch::set_upstream(Path::new(&root), &upstream)).await
}

#[tauri::command]
pub async fn submodules(root: String) -> GitResult<Vec<Submodule>> {
    blocking(move || git::submodule::list(Path::new(&root))).await
}

#[tauri::command]
pub async fn submodule_diff(root: String, group: String, path: String, rev: Option<String>) -> GitResult<SubmoduleDiff> {
    blocking(move || git::submodule::diff(Path::new(&root), &group, &path, rev.as_deref())).await
}

#[tauri::command]
pub async fn update_submodule(window: WebviewWindow, root: String, path: String) -> GitResult<()> {
    network(window, move |net| git::submodule::update(Path::new(&root), &path, net)).await
}

#[tauri::command]
pub async fn worktrees(root: String) -> GitResult<Vec<Worktree>> {
    blocking(move || git::worktree::list(Path::new(&root))).await
}

#[tauri::command]
pub async fn add_worktree(root: String, path: String, branch: String, create: bool) -> GitResult<()> {
    blocking(move || git::worktree::add(Path::new(&root), &path, &branch, create)).await
}

#[tauri::command]
pub async fn remove_worktree(root: String, path: String, force: bool) -> GitResult<()> {
    blocking(move || git::worktree::remove(Path::new(&root), &path, force)).await
}

#[tauri::command]
pub async fn lfs_info(root: String) -> GitResult<LfsInfo> {
    blocking(move || Ok(git::lfs::info(Path::new(&root)))).await
}

#[tauri::command]
pub async fn lfs_pull(window: WebviewWindow, root: String) -> GitResult<String> {
    network(window, move |net| git::lfs::pull(Path::new(&root), net)).await
}

/// Async on purpose: building a window from a sync command deadlocks on Windows.
#[tauri::command]
pub async fn new_window(app: AppHandle, path: Option<String>) -> GitResult<()> {
    crate::windows::open(&app, path)
}
