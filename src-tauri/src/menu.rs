//! Native application menu. Items carry string ids; clicks are forwarded to
//! the frontend as a `menu` event whose payload is the id, so all command
//! handling lives in one place (src/menu.ts).

use tauri::menu::{Menu, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

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

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
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
        .separator()
        .item(&item(app, "open_in_explorer", reveal_label(), None)?)
        .item(&item(app, "open_terminal", "Open Terminal Here", None)?);
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
        .separator()
        .item(&item(app, "toggle_whitespace", "Ignore Whitespace", None)?)
        .item(&item(app, "toggle_word_wrap", "Word Wrap", Some("Alt+Z"))?)
        .separator()
        .item(&theme)
        .separator()
        .item(&item(app, "show_history", "History", Some("CmdOrCtrl+Shift+H"))?)
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
        .build()?;
    menu.append(&repo)?;

    let branch = SubmenuBuilder::new(app, "Branch")
        .item(&item(app, "new_branch", "New Branch…", Some("CmdOrCtrl+Shift+N"))?)
        .item(&item(app, "checkout_branch", "Checkout…", None)?)
        .separator()
        .item(&item(app, "merge_branch", "Merge Into Current…", None)?)
        .item(&item(app, "rebase_branch", "Rebase Current Onto…", None)?)
        .separator()
        .item(&item(app, "delete_branch", "Delete Branch…", None)?)
        .build()?;
    menu.append(&branch)?;

    let mut help = SubmenuBuilder::new(app, "Help")
        .item(&item(app, "shortcuts", "Keyboard Shortcuts", None)?)
        .item(&item(app, "check_updates", "Check for Updates…", None)?);
    #[cfg(not(target_os = "macos"))]
    {
        help = help.separator().item(&item(app, "about", "About Grove", None)?);
    }
    menu.append(&help.build()?)?;

    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let _ = app.emit("menu", event.id().as_ref());
    });
    Ok(())
}

fn reveal_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Reveal in Finder"
    } else {
        "Open in File Explorer"
    }
}
