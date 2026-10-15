//! Extra Grove windows, so several repositories can be open at once. Each
//! window loads the same frontend with its own store; the label ties it to
//! its own file watcher.

use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

use crate::git::{GitError, GitResult};

/// Labels must match the `grove-*` pattern in capabilities/default.json.
static NEXT: AtomicUsize = AtomicUsize::new(1);

/// Opens a new window on the welcome screen, or on `path` if given.
pub fn open<R: Runtime>(app: &AppHandle<R>, path: Option<String>) -> GitResult<()> {
    let label = loop {
        let label = format!("grove-{}", NEXT.fetch_add(1, Ordering::Relaxed));
        if app.get_webview_window(&label).is_none() {
            break label;
        }
    };
    // Handed over as a global read once at startup (see App.tsx), rather than
    // a URL parameter, so any path survives without escaping concerns.
    let init = format!(
        "window.__GROVE_OPEN__ = {};",
        serde_json::to_string(&path).map_err(|e| GitError::new(e.to_string()))?
    );
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Grove")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 500.0)
        .initialization_script(init)
        .build()
        .map(drop)
        .map_err(|e| GitError::new(format!("could not open a new window: {e}")))
}

/// Menu clicks arrive app-wide; only the focused window should act on them.
pub fn emit_to_focused<R: Runtime>(app: &AppHandle<R>, event: &str, payload: &str) {
    let windows = app.webview_windows();
    // Fall back to the main window (or any) if focus can't be determined.
    let target = windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| windows.get("main"))
        .or_else(|| windows.values().next());
    if let Some(w) = target {
        let _ = app.emit_to(tauri::EventTarget::webview_window(w.label()), event, payload);
    }
}
