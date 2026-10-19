//! Creating repositories (clone, init) and the git identity used for commits.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::stream::Op;
use super::{run, GitError, GitResult};

/// The folder name `git clone` would pick for `url`: last path segment,
/// minus a trailing `.git`.
fn clone_dir_name(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches(['/', '\\']).trim_end_matches(".git");
    let name = trimmed.rsplit(['/', '\\', ':']).next()?.trim();
    (!name.is_empty() && name != "." && name != "..").then(|| name.to_string())
}

/// Clones `url` into a new folder under `parent`. Returns the new repo path.
#[cfg_attr(not(test), allow(dead_code))] // UI-less callers (tests) use it.
pub fn clone(url: &str, parent: &Path) -> GitResult<PathBuf> {
    clone_with(url, parent, &Op::silent())
}

/// Like `clone`, reporting progress and honouring cancel through `net`.
pub fn clone_with(url: &str, parent: &Path, net: &Op) -> GitResult<PathBuf> {
    let url = url.trim();
    if url.is_empty() || url.starts_with('-') {
        return Err(GitError::new("Enter a repository URL."));
    }
    let name = clone_dir_name(url).ok_or_else(|| GitError::new("Couldn't work out a folder name from that URL."))?;
    let dest = parent.join(&name);
    if dest.exists() {
        return Err(GitError::new(format!("{} already exists.", dest.display())));
    }
    // `--` ends options, so the URL can never be read as one.
    if let Err(e) = net.run(parent, &["clone", "--", url, &name]) {
        // git tidies up after its own failures, but not after being killed.
        remove_partial_clone(&dest);
        return Err(e);
    }
    Ok(dest)
}

/// Deletes a clone's half-written folder. Retries briefly because killed
/// processes can hold file handles for a moment on Windows.
fn remove_partial_clone(dest: &Path) {
    for _ in 0..20 {
        if !dest.exists() || std::fs::remove_dir_all(dest).is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// Runs `git init` in `path` (creating the folder if needed).
pub fn init(path: &Path) -> GitResult<()> {
    std::fs::create_dir_all(path).map_err(|e| GitError::new(format!("could not create {}: {e}", path.display())))?;
    // A repository root has its own .git (a folder, or a file for worktrees
    // and submodules). Comparing with `rev-parse --show-toplevel` instead is
    // unreliable: git reports canonical paths (macOS /private/var, Windows
    // long names) that needn't match the path we were given.
    if path.join(".git").exists() {
        return Err(GitError::new("That folder is already a git repository."));
    }
    run(path, &["init"]).map(drop)
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    /// What commits in this repo will use.
    pub name: String,
    pub email: String,
    /// True when the repo overrides the global identity.
    pub local: bool,
}

fn config_get(root: &Path, scope: Option<&str>, key: &str) -> String {
    let mut args = vec!["config"];
    if let Some(scope) = scope {
        args.push(scope);
    }
    args.extend(["--get", key]);
    run(root, &args).map(|v| v.trim().to_string()).unwrap_or_default()
}

pub fn identity(root: &Path) -> Identity {
    Identity {
        name: config_get(root, None, "user.name"),
        email: config_get(root, None, "user.email"),
        local: !config_get(root, Some("--local"), "user.name").is_empty()
            || !config_get(root, Some("--local"), "user.email").is_empty(),
    }
}

/// Saves the identity for this repository only, or globally for every repo.
pub fn set_identity(root: &Path, name: &str, email: &str, global: bool) -> GitResult<()> {
    let (name, email) = (name.trim(), email.trim());
    if name.is_empty() || email.is_empty() {
        return Err(GitError::new("Enter both a name and an email."));
    }
    let scope = if global { "--global" } else { "--local" };
    run(root, &["config", scope, "user.name", name])?;
    run(root, &["config", scope, "user.email", email])?;
    if global {
        // A repo-level identity would still win over the new global one.
        let _ = run(root, &["config", "--local", "--unset", "user.name"]);
        let _ = run(root, &["config", "--local", "--unset", "user.email"]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clone_names() {
        assert_eq!(clone_dir_name("https://github.com/a/grove.git").as_deref(), Some("grove"));
        assert_eq!(clone_dir_name("git@github.com:a/grove.git").as_deref(), Some("grove"));
        assert_eq!(clone_dir_name("C:\\repos\\thing\\").as_deref(), Some("thing"));
        assert_eq!(clone_dir_name("https://host/").as_deref(), Some("host"));
        assert_eq!(clone_dir_name(""), None);
    }

    #[test]
    fn init_clone_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        init(&src).unwrap();
        assert!(init(&src).is_err(), "already a repo");

        set_identity(&src, "Local Person", "local@example.com", false).unwrap();
        let id = identity(&src);
        assert_eq!((id.name.as_str(), id.email.as_str(), id.local), ("Local Person", "local@example.com", true));
        run(&src, &["commit", "--allow-empty", "-qm", "init"]).unwrap();

        let dest = clone(src.to_str().unwrap(), tmp.path().join("clones").as_path()).err();
        assert!(dest.is_some(), "parent must exist");
        std::fs::create_dir(tmp.path().join("clones")).unwrap();
        let dest = clone(src.to_str().unwrap(), &tmp.path().join("clones")).unwrap();
        assert!(dest.join(".git").exists());
        assert!(clone(src.to_str().unwrap(), &tmp.path().join("clones")).is_err(), "already exists");
        assert!(clone("--upload-pack=x", tmp.path()).is_err());
    }

    #[test]
    fn cancelled_clone_removes_its_folder() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, OnceLock};

        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("big");
        init(&src).unwrap();
        set_identity(&src, "T", "t@example.com", false).unwrap();
        // Enough incompressible data that the transfer is still running when
        // the first progress line arrives.
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        for i in 0..200 {
            let data: Vec<u8> = (0..20_000)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    seed as u8
                })
                .collect();
            std::fs::write(src.join(format!("f{i}.bin")), data).unwrap();
        }
        run(&src, &["add", "."]).unwrap();
        run(&src, &["commit", "-qm", "big"]).unwrap();

        let parent = tmp.path().join("clones");
        std::fs::create_dir(&parent).unwrap();
        let progressed = Arc::new(AtomicBool::new(false));
        let seen = progressed.clone();
        let flag = Arc::new(OnceLock::<Arc<AtomicBool>>::new());
        let flag2 = flag.clone();
        let net = Op::new("", move |_| {
            // Cancel as soon as git reports anything, i.e. mid-transfer.
            seen.store(true, Ordering::SeqCst);
            flag2.get().unwrap().store(true, Ordering::SeqCst);
        });
        flag.set(net.cancel_flag()).unwrap();
        // file:// forces the regular transport, which reports progress.
        let url = format!("file:///{}", src.to_str().unwrap().replace('\\', "/").trim_start_matches('/'));
        let err = clone_with(&url, &parent, &net).unwrap_err();
        assert!(progressed.load(Ordering::SeqCst), "no progress was reported");
        assert_eq!(err.message, "Cancelled.");
        assert!(!parent.join("big").exists(), "partial clone left behind");
    }
}
