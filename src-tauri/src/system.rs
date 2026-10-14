//! Hand-offs to the operating system: file manager, terminal, default editor.

use std::path::Path;
use std::process::Command;

use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::git::{repo_path, GitError, GitResult};

pub fn reveal<R: Runtime>(app: &AppHandle<R>, path: &Path) -> GitResult<()> {
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| GitError::new(format!("could not open the file manager: {e}")))
}

/// Opens a repo file in the user's default app, creating it first if
/// `create` is set (used for .gitignore).
pub fn open_repo_file<R: Runtime>(app: &AppHandle<R>, root: &Path, rel: &str, create: bool) -> GitResult<()> {
    let full = repo_path(root, rel)?;
    if create && !full.exists() {
        std::fs::write(&full, "").map_err(|e| GitError::new(format!("could not create {rel}: {e}")))?;
    }
    app.opener()
        .open_path(full.to_string_lossy(), None::<&str>)
        .map_err(|e| GitError::new(format!("could not open {rel}: {e}")))
}

/// Opens a terminal window in `dir`: Windows Terminal if installed, else
/// Command Prompt; Terminal.app on macOS; the system default on Linux.
pub fn open_terminal(dir: &Path) -> GitResult<()> {
    let fail = |e: std::io::Error| GitError::new(format!("could not open a terminal: {e}"));

    #[cfg(windows)]
    {
        if Command::new("wt.exe").arg("-d").arg(dir).spawn().is_ok() {
            return Ok(());
        }
        // `start` opens a new console window; it inherits the working directory.
        Command::new("cmd.exe")
            .args(["/c", "start", "", "cmd.exe"])
            .current_dir(dir)
            .spawn()
            .map(drop)
            .map_err(fail)
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").args(["-a", "Terminal"]).arg(dir).spawn().map(drop).map_err(fail)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("x-terminal-emulator").current_dir(dir).spawn().map(drop).map_err(fail)
    }
}
