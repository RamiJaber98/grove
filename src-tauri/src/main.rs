// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Credential prompts: git/ssh launched us as their askpass helper.
    // Answer through the running Grove and exit without opening a window.
    if let Some(code) = grove_lib::askpass::client_main() {
        std::process::exit(code);
    }
    grove_lib::run()
}
