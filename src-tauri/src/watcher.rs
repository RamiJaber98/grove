//! Watches the open repository and emits a debounced `repo-changed` event so
//! the panel stays current when files are edited or git is used elsewhere.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Default)]
pub struct RepoWatcher(Mutex<Option<Debouncer<RecommendedWatcher>>>);

impl RepoWatcher {
    /// Replaces any existing watch with one on `root`.
    pub fn watch<R: Runtime>(&self, app: AppHandle<R>, root: PathBuf) -> Result<(), String> {
        let mut slot = self.0.lock().unwrap();
        *slot = None;

        let git_dir = root.join(".git");
        let mut debouncer = new_debouncer(Duration::from_millis(300), move |res: DebounceEventResult| {
            if let Ok(events) = res {
                if events.iter().any(|e| is_relevant(&git_dir, &e.path)) {
                    let _ = app.emit("repo-changed", ());
                }
            }
        })
        .map_err(|e| e.to_string())?;
        debouncer
            .watcher()
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;

        *slot = Some(debouncer);
        Ok(())
    }

    pub fn stop(&self) {
        *self.0.lock().unwrap() = None;
    }
}

/// Working-tree changes always matter. Inside `.git`, only files that change
/// what the panel shows do: the index, HEAD, refs (branches, stash) and merge
/// state. Object writes and lock files are noise.
fn is_relevant(git_dir: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(git_dir) else {
        return true;
    };
    let parts: Vec<_> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect();
    match parts.as_slice() {
        [] => false,
        [name, ..] if name.ends_with(".lock") => false,
        [file] => matches!(*file, "index" | "HEAD" | "packed-refs" | "MERGE_HEAD" | "REBASE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD"),
        ["refs", ..] | ["logs", "refs", "stash"] => !parts.last().is_some_and(|l| l.ends_with(".lock")),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_git_dir_noise() {
        let git = Path::new("/r/.git");
        assert!(is_relevant(git, Path::new("/r/src/main.rs")));
        assert!(is_relevant(git, Path::new("/r/.git/index")));
        assert!(is_relevant(git, Path::new("/r/.git/refs/heads/main")));
        assert!(is_relevant(git, Path::new("/r/.git/refs/stash")));
        assert!(!is_relevant(git, Path::new("/r/.git/index.lock")));
        assert!(!is_relevant(git, Path::new("/r/.git/refs/heads/main.lock")));
        assert!(!is_relevant(git, Path::new("/r/.git/objects/ab/cdef")));
        assert!(!is_relevant(git, Path::new("/r/.git/logs/HEAD")));
        assert!(is_relevant(git, Path::new("/r/.git/logs/refs/stash")));
    }
}
