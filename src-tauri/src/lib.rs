mod commands;
mod extras;
mod git;
mod menu;
mod system;
mod watcher;
mod windows;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Only the main window's size and position are remembered; extra
        // windows (grove-N) are transient.
        .plugin(tauri_plugin_window_state::Builder::default().with_filter(|label| label == "main").build())
        .manage(watcher::RepoWatcher::default())
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        // Multiple windows: drop a closed window's file watcher.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<watcher::RepoWatcher>().stop(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Extras (extras.rs): images, remote branches, submodules, worktrees, LFS, windows.
            extras::image_versions,
            extras::delete_remote_branch,
            extras::publish_branch,
            extras::set_upstream,
            extras::submodules,
            extras::submodule_diff,
            extras::update_submodule,
            extras::worktrees,
            extras::add_worktree,
            extras::remove_worktree,
            extras::lfs_info,
            extras::lfs_pull,
            extras::new_window,
            commands::launch_path,
            commands::open_repo,
            commands::close_repo,
            commands::status,
            commands::stage,
            commands::unstage,
            commands::unstage_all,
            commands::discard,
            commands::file_versions,
            commands::commit,
            commands::last_commit_message,
            commands::undo_last_commit,
            commands::remote_op,
            commands::stash_list,
            commands::stash_push,
            commands::stash_apply,
            commands::stash_drop,
            commands::branches,
            commands::checkout,
            commands::create_branch,
            commands::rename_branch,
            commands::delete_branch,
            commands::merge,
            commands::rebase,
            commands::operation,
            commands::tags,
            commands::create_tag,
            commands::delete_tag,
            commands::remotes,
            commands::add_remote,
            commands::remove_remote,
            commands::reset,
            commands::clean,
            commands::recent_commits,
            commands::log,
            commands::commit_detail,
            commands::cherry_pick,
            commands::revert,
            commands::checkout_detached,
            commands::clone_repo,
            commands::init_repo,
            commands::identity,
            commands::set_identity,
            commands::open_folder,
            commands::open_terminal,
            commands::open_repo_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Grove");
}
