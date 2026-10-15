//! Native application menu. Items carry string ids; clicks are forwarded to
//! the frontend as a `menu` event whose payload is the id, so all command
//! handling lives in one place (src/runCommand.ts).
//!
//! The menu is handed to the Builder rather than attached in `setup`, so the
//! window is created with it. Attaching it later shrinks the window's content
//! area by the menu's height after window-state has restored the saved size,
//! making the window 20px shorter on every launch.

use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    let mut b = MenuItemBuilder::with_id(id, text);
    if let Some(a) = accelerator {
        b = b.accelerator(a);
    }
    b.build(app)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;

    // macOS convention: About/Settings/Quit live in the app-name menu.
    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "Grove")
            .item(&item(app, "about", "About Grove", None)?)
            .separator()
            .item(&item(app, "settings", "Settings…", Some("CmdOrCtrl+,"))?)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu.append(&app_menu)?;
    }

    let mut file = SubmenuBuilder::new(app, "File")
        .item(&item(app, "open_repo", "Open Repository…", Some("CmdOrCtrl+O"))?)
        .item(&item(app, "clone_repo", "Clone Repository…", None)?)
        .item(&item(app, "init_repo", "Initialize Repository…", None)?)
        // Extras: multiple windows.
        .item(&item(app, "new_window", "New Window", None)?)
        .separator()
        .item(&item(app, "open_in_explorer", file_manager_label(), None)?)
        .item(&item(app, "open_terminal", "Open Terminal Here", None)?)
        .separator()
        .item(&item(app, "close_repo", "Close Repository", Some("CmdOrCtrl+W"))?);
    #[cfg(not(target_os = "macos"))]
    {
        file = file
            .separator()
            .item(&item(app, "settings", "Settings…", Some("CmdOrCtrl+,"))?)
            .separator()
            .item(&tauri::menu::PredefinedMenuItem::quit(app, Some("Exit"))?);
    }
    menu.append(&file.build()?)?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item(app, "find", "Find in Diff", Some("CmdOrCtrl+F"))?)
        .build()?;
    menu.append(&edit)?;

    let theme = SubmenuBuilder::new(app, "Theme")
        .item(&item(app, "theme_system", "System", None)?)
        .item(&item(app, "theme_light", "Light", None)?)
        .item(&item(app, "theme_dark", "Dark", None)?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item(app, "diff_side_by_side", "Side-by-Side Diff", None)?)
        .item(&item(app, "diff_inline", "Inline Diff", None)?)
        .item(&item(app, "next_change", "Next Change", Some("F7"))?)
        .item(&item(app, "prev_change", "Previous Change", Some("Shift+F7"))?)
        .separator()
        .item(&item(app, "toggle_whitespace", "Ignore Whitespace", None)?)
        .item(&item(app, "toggle_word_wrap", "Word Wrap", Some("Alt+Z"))?)
        .separator()
        .item(&theme)
        .separator()
        .item(&item(app, "show_history", "History", Some("CmdOrCtrl+Shift+H"))?)
        // File history and blame for the file selected in the diff.
        .item(&item(app, "file_history", "File History", None)?)
        .item(&item(app, "blame_file", "Blame", None)?)
        .item(&item(app, "refresh", "Refresh", Some("F5"))?)
        .build()?;
    menu.append(&view)?;

    let repo = SubmenuBuilder::new(app, "Repository")
        .item(&item(app, "fetch", "Fetch", None)?)
        .item(&item(app, "pull", "Pull", None)?)
        .item(&item(app, "push", "Push", None)?)
        .separator()
        .item(&item(app, "manage_remotes", "Remotes…", None)?)
        .item(&item(app, "edit_gitignore", "Edit .gitignore", None)?)
        .item(&item(app, "edit_git_config", "Git Identity…", None)?)
        // Extras: worktrees and submodules.
        .separator()
        .item(&item(app, "worktrees", "Worktrees…", None)?)
        .item(&item(app, "submodules", "Submodules…", None)?)
        .build()?;
    menu.append(&repo)?;

    let branch = SubmenuBuilder::new(app, "Branch")
        .item(&item(app, "new_branch", "New Branch…", Some("CmdOrCtrl+Shift+N"))?)
        .item(&item(app, "checkout_branch", "Checkout…", Some("CmdOrCtrl+Shift+B"))?)
        .item(&item(app, "rename_branch", "Rename Current Branch…", None)?)
        .separator()
        .item(&item(app, "merge_branch", "Merge Into Current…", None)?)
        .item(&item(app, "rebase_branch", "Rebase Current Onto…", None)?)
        .item(&item(app, "interactive_rebase", "Interactive Rebase…", None)?)
        .separator()
        .item(&item(app, "delete_branch", "Delete Branch…", None)?)
        // Extras: remote branches.
        .item(&item(app, "delete_remote_branch", "Delete Remote Branch…", None)?)
        .separator()
        .item(&item(app, "publish_branch", "Publish Branch To…", None)?)
        .item(&item(app, "set_upstream", "Set Upstream…", None)?)
        // Compare refs
        .separator()
        .item(&item(app, "compare_refs", "Compare…", None)?)
        .build()?;
    menu.append(&branch)?;

    let mut help = SubmenuBuilder::new(app, "Help")
        .item(&item(app, "shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+/"))?);
    #[cfg(not(target_os = "macos"))]
    {
        help = help.separator().item(&item(app, "about", "About Grove", None)?);
    }
    menu.append(&help.build()?)?;

    Ok(menu)
}

/// With several windows open, only the focused one handles the click.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    crate::windows::emit_to_focused(app, "menu", event.id().as_ref());
}

fn file_manager_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Open in Finder"
    } else {
        "Open in File Explorer"
    }
}
