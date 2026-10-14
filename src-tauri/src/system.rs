//! Hand-offs to the operating system: file manager, terminal, default editor.

use std::path::Path;
use std::process::Command;

use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::git::{repo_path, GitError, GitResult};

/// Opens `dir` itself in Explorer / Finder.
pub fn open_folder<R: Runtime>(app: &AppHandle<R>, dir: &Path) -> GitResult<()> {
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
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

// ── File panel context menu ─────────────────────────────────────────────

/// Selects a repo file in Explorer / Finder. A deleted file can't be
/// selected, so its nearest surviving folder is opened instead.
pub fn reveal_repo_file<R: Runtime>(app: &AppHandle<R>, root: &Path, rel: &str) -> GitResult<()> {
    let full = repo_path(root, rel)?;
    if !full.exists() {
        let dir = full.ancestors().find(|p| p.is_dir()).unwrap_or(root);
        return open_folder(app, dir);
    }
    app.opener()
        .reveal_item_in_dir(&full)
        .map_err(|e| GitError::new(format!("could not reveal {rel}: {e}")))
}

/// Opens repo files in VS Code when its `code` launcher is installed, else
/// in the default app. Returns whether VS Code was used, so the UI can say
/// why a file opened somewhere else.
pub fn open_in_editor<R: Runtime>(app: &AppHandle<R>, root: &Path, rels: &[String]) -> GitResult<bool> {
    let full = rels.iter().map(|r| repo_path(root, r)).collect::<GitResult<Vec<_>>>()?;
    if full.is_empty() {
        return Ok(false);
    }
    if launch_vscode(&full) {
        return Ok(true);
    }
    for (path, rel) in full.iter().zip(rels) {
        app.opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|e| GitError::new(format!("could not open {rel}: {e}")))?;
    }
    Ok(false)
}

fn launch_vscode(paths: &[std::path::PathBuf]) -> bool {
    #[cfg(windows)]
    {
        // `code` is a batch file on Windows; Rust quotes batch-file
        // arguments safely (and refuses ones it can't), so names with
        // spaces or `&` are fine.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("code.cmd").args(paths).creation_flags(CREATE_NO_WINDOW).spawn().is_ok()
    }
    #[cfg(target_os = "macos")]
    {
        // GUI apps don't inherit the shell's PATH, so go by bundle id.
        Command::new("open")
            .args(["-b", "com.microsoft.VSCode"])
            .args(paths)
            .status()
            .is_ok_and(|s| s.success())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("code").args(paths).spawn().is_ok()
    }
}
