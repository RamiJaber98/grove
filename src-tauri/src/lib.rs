mod commands;
mod git;
mod menu;
mod watcher;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(watcher::RepoWatcher::default())
        .setup(|app| {
            menu::install(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Grove");
}
