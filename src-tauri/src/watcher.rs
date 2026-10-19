//! Watches each window's open repository and emits a debounced
//! `repo-changed` event to that window only, so its panel stays current when
//! files are edited or git is used elsewhere.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, EventTarget, Runtime};

/// One watch per window label, since each window can have a repo open.
#[derive(Default)]
pub struct RepoWatcher(Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>);

impl RepoWatcher {
    /// Replaces any existing watch for `window` with one on `root`. `git_dir`
    /// is this worktree's own git directory and `common_dir` the one shared
    /// by all worktrees (both `root/.git` except in a linked worktree, where
    /// they live outside `root` and are watched as well).
    pub fn watch<R: Runtime>(
        &self,
        app: AppHandle<R>,
        window: &str,
        root: PathBuf,
        git_dir: PathBuf,
        common_dir: PathBuf,
    ) -> Result<(), String> {
        let mut map = self.0.lock().unwrap();
        map.remove(window);

        let target = EventTarget::webview_window(window);
        let dirs = GitDirs { own: git_dir, common: common_dir };
        let watch_common = !dirs.common.starts_with(&root);
        let common = dirs.common.clone();
        let mut debouncer = new_debouncer(Duration::from_millis(300), move |res: DebounceEventResult| {
            if let Ok(events) = res {
                if events.iter().any(|e| is_relevant(&dirs, &e.path)) {
                    let _ = app.emit_to(target.clone(), "repo-changed", ());
                }
            }
        })
        .map_err(|e| e.to_string())?;
        debouncer
            .watcher()
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
        // A linked worktree's own git dir sits inside the common one.
        if watch_common {
            debouncer
                .watcher()
                .watch(&common, RecursiveMode::Recursive)
                .map_err(|e| e.to_string())?;
        }

        map.insert(window.to_string(), debouncer);
        Ok(())
    }

    pub fn stop(&self, window: &str) {
        self.0.lock().unwrap().remove(window);
    }
}

struct GitDirs {
    own: PathBuf,
    common: PathBuf,
}

fn parts(rel: &Path) -> Vec<&str> {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect()
}

/// Working-tree changes always matter. Inside the git dirs, only files that
/// change what the panel shows do: this worktree's index, HEAD and merge
/// state, and the shared refs (branches, stash). Object writes, lock files
/// and other worktrees' state are noise.
fn is_relevant(dirs: &GitDirs, path: &Path) -> bool {
    // Checked first: in a linked worktree it's nested inside the common dir.
    if let Ok(rel) = path.strip_prefix(&dirs.own) {
        let parts = parts(rel);
        return match parts.as_slice() {
            [name, ..] if name.ends_with(".lock") => false,
            [file] => matches!(*file, "index" | "HEAD" | "MERGE_HEAD" | "REBASE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD")
                || is_shared_ref(&parts),
            _ => is_shared_ref(&parts),
        };
    }
    match path.strip_prefix(&dirs.common) {
        Ok(rel) => is_shared_ref(&parts(rel)),
        Err(_) => true,
    }
}

/// Refs and the stash, which every worktree shares.
fn is_shared_ref(parts: &[&str]) -> bool {
    match parts {
        ["packed-refs"] => true,
        ["refs", ..] | ["logs", "refs", "stash"] => !parts.last().is_some_and(|l| l.ends_with(".lock")),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_git_dir_noise() {
        let git = &GitDirs { own: "/r/.git".into(), common: "/r/.git".into() };
        assert!(is_relevant(git, Path::new("/r/src/main.rs")));
        assert!(is_relevant(git, Path::new("/r/.git/index")));
        assert!(is_relevant(git, Path::new("/r/.git/packed-refs")));
        assert!(is_relevant(git, Path::new("/r/.git/refs/heads/main")));
        assert!(is_relevant(git, Path::new("/r/.git/refs/stash")));
        assert!(!is_relevant(git, Path::new("/r/.git/index.lock")));
        assert!(!is_relevant(git, Path::new("/r/.git/refs/heads/main.lock")));
        assert!(!is_relevant(git, Path::new("/r/.git/objects/ab/cdef")));
        assert!(!is_relevant(git, Path::new("/r/.git/logs/HEAD")));
        assert!(is_relevant(git, Path::new("/r/.git/logs/refs/stash")));
    }

    #[test]
    fn linked_worktree_watches_its_own_state_and_shared_refs() {
        let git = &GitDirs { own: "/main/.git/worktrees/wt".into(), common: "/main/.git".into() };
        assert!(is_relevant(git, Path::new("/wt/src/lib.rs")));
        assert!(is_relevant(git, Path::new("/main/.git/worktrees/wt/index")));
        assert!(is_relevant(git, Path::new("/main/.git/worktrees/wt/HEAD")));
        assert!(is_relevant(git, Path::new("/main/.git/refs/heads/feature")));
        assert!(is_relevant(git, Path::new("/main/.git/packed-refs")));
        // The main worktree's own state and other worktrees' don't matter here.
        assert!(!is_relevant(git, Path::new("/main/.git/index")));
        assert!(!is_relevant(git, Path::new("/main/.git/HEAD")));
        assert!(!is_relevant(git, Path::new("/main/.git/worktrees/other/index")));
        assert!(!is_relevant(git, Path::new("/main/.git/objects/ab/cdef")));
    }
}
