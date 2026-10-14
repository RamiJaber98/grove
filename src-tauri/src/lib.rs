mod commands;
mod git;
mod menu;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            menu::install(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::launch_path,
            commands::open_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Grove");
}
