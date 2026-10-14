use std::path::{Path, PathBuf};

use crate::git::{self, GitResult, RepoInfo};

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

#[tauri::command]
pub async fn open_repo(path: String) -> GitResult<RepoInfo> {
    // Git calls block; keep them off the main thread.
    tauri::async_runtime::spawn_blocking(move || git::repo_info(Path::new(&path)))
        .await
        .unwrap_or_else(|e| Err(git::GitError { message: e.to_string() }))
}
