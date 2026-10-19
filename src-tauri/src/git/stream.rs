//! Streaming runner for long network operations (clone, fetch, pull, push).
//!
//! Unlike `run`, this reads git's stderr as it arrives so the UI can show
//! `--progress` output, can kill the process tree when the user cancels, and
//! lets git ask for credentials through Grove's askpass bridge.

use std::io::Read;
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::{command, finish, spawn_error, GitError, GitResult};

/// One parsed progress line, e.g. `Receiving objects:  45% (450/1000)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: String,
    /// None for phases git reports as a bare count ("Enumerating objects: 5").
    pub percent: Option<u8>,
}

/// Parses a single progress segment (git separates updates with `\r`).
/// Returns None for anything else, including errors, so they stay in the
/// message shown to the user.
pub fn parse_progress(line: &str) -> Option<Progress> {
    let line = line.trim();
    let line = line.strip_prefix("remote:").map(str::trim_start).unwrap_or(line);
    let (phase, rest) = line.split_once(':')?;
    let rest = rest.trim_start();
    // Progress phases are capitalised plain words ("Receiving objects");
    // git's own "fatal:", "error:", "warning:" prefixes are lowercase.
    if !phase.starts_with(|c: char| c.is_ascii_uppercase())
        || !phase.chars().all(|c| c.is_ascii_alphabetic() || c == ' ')
    {
        return None;
    }
    if !rest.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let percent = rest[digits.len()..]
        .starts_with('%')
        .then(|| digits.parse::<u8>().ok())
        .flatten()
        .map(|p| p.min(100));
    Some(Progress { phase: phase.trim().to_string(), percent })
}

/// Runs `git <args>` in `cwd`, calling `on_progress` for each progress update.
/// Setting `cancel` kills git and everything it started, and the call
/// returns a "Cancelled." error. Output and error messages otherwise match
/// `run`, with progress lines left out. Credential prompts show in `window`.
pub fn run_streaming(
    cwd: &Path,
    args: &[&str],
    on_progress: &mut dyn FnMut(Progress),
    cancel: &AtomicBool,
    window: &str,
) -> GitResult<String> {
    let mut cmd = command(cwd, args);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::askpass::configure(&mut cmd, window);
    #[cfg(unix)]
    {
        // Own process group, so cancelling can kill ssh/helpers too.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(spawn_error)?;

    let mut stdout = child.stdout.take().expect("stdout is piped");
    let stdout_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let (tx, rx) = mpsc::channel::<String>();
    let mut stderr = child.stderr.take().expect("stderr is piped");
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending = Vec::new();
        loop {
            let n = match stderr.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            for &b in &buf[..n] {
                if b == b'\r' || b == b'\n' {
                    if !pending.is_empty() && tx.send(String::from_utf8_lossy(&pending).into_owned()).is_err() {
                        return;
                    }
                    pending.clear();
                } else {
                    pending.push(b);
                }
            }
        }
        if !pending.is_empty() {
            let _ = tx.send(String::from_utf8_lossy(&pending).into_owned());
        }
    });

    let mut messages: Vec<String> = Vec::new();
    let mut last: Option<Progress> = None;
    let mut killed = false;
    let mut exited_at: Option<Instant> = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(segment) => match parse_progress(&segment) {
                Some(p) => {
                    if last.as_ref() != Some(&p) {
                        last = Some(p.clone());
                        on_progress(p);
                    }
                }
                None => messages.push(segment),
            },
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        if cancel.load(Ordering::SeqCst) && !killed {
            kill_tree(&mut child);
            killed = true;
        }
        // A helper that outlives git (e.g. an ssh control master) can keep
        // stderr open; don't wait on it for long once git itself is done.
        match exited_at {
            Some(t) if t.elapsed() > Duration::from_secs(1) => break,
            Some(_) => {}
            None => {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    exited_at = Some(Instant::now());
                }
            }
        }
    }

    let status = child.wait().map_err(spawn_error)?;
    let stdout = stdout_thread.join().unwrap_or_default();
    if killed {
        return Err(GitError::new("Cancelled."));
    }
    let output = std::process::Output { status, stdout, stderr: messages.join("\n").into_bytes() };
    finish(args, output)
}

/// Kills git and its descendants (ssh, credential helpers, askpass).
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(unix)]
    {
        // Negative pid = the whole process group set up at spawn.
        let _ = std::process::Command::new("kill")
            .args(["-KILL", "--", &format!("-{}", child.id())])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    // Fallback if the tree kill wasn't possible.
    let _ = child.kill();
}

/// Operations that can currently be cancelled, with the window that started each.
static ACTIVE: Mutex<Vec<(Arc<AtomicBool>, String)>> = Mutex::new(Vec::new());

/// A cancellable, progress-reporting network operation started from one
/// window. Registered while alive so that window's Cancel button
/// (`cancel_window`) can reach it.
pub struct Op {
    cancel: Arc<AtomicBool>,
    window: String,
    sink: Box<dyn Fn(&Progress) + Send>,
}

impl Op {
    pub fn new(window: &str, sink: impl Fn(&Progress) + Send + 'static) -> Self {
        let cancel = Arc::new(AtomicBool::new(false));
        ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).push((cancel.clone(), window.to_string()));
        Self { cancel, window: window.to_string(), sink: Box::new(sink) }
    }

    /// No window and no progress reporting; still cancellable via its flag.
    #[cfg_attr(not(test), allow(dead_code))] // UI-less callers (tests) use it.
    pub fn silent() -> Self {
        Self::new("", |_| {})
    }

    /// The flag that cancels this operation.
    #[cfg_attr(not(test), allow(dead_code))] // UI-less callers (tests) use it.
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Runs `git <args>` with `--progress` inserted after the subcommand.
    pub fn run(&self, cwd: &Path, args: &[&str]) -> GitResult<String> {
        let mut full: Vec<&str> = Vec::with_capacity(args.len() + 1);
        if let Some((sub, rest)) = args.split_first() {
            full.push(sub);
            full.push("--progress");
            full.extend_from_slice(rest);
        }
        self.run_plain(cwd, &full)
    }

    /// Runs `git <args>` as given, for commands whose `--progress` option
    /// doesn't go right after the subcommand (or that have none).
    pub fn run_plain(&self, cwd: &Path, args: &[&str]) -> GitResult<String> {
        // Multi-step operations (sync) stop between steps too.
        if self.cancelled() {
            return Err(GitError::new("Cancelled."));
        }
        run_streaming(cwd, args, &mut |p| (self.sink)(&p), &self.cancel, &self.window)
    }
}

impl Drop for Op {
    fn drop(&mut self) {
        ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).retain(|(c, _)| !Arc::ptr_eq(c, &self.cancel));
    }
}

/// Cancels the network operations `window` started.
pub fn cancel_window(window: &str) {
    for (c, w) in ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).iter() {
        if w == window {
            c.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(phase: &str, percent: Option<u8>) -> Option<Progress> {
        Some(Progress { phase: phase.into(), percent })
    }

    #[test]
    fn parses_progress_lines() {
        assert_eq!(parse_progress("Receiving objects:  45% (450/1000), 1.20 MiB | 600.00 KiB/s"), p("Receiving objects", Some(45)));
        assert_eq!(parse_progress("remote: Compressing objects: 100% (3/3), done."), p("Compressing objects", Some(100)));
        assert_eq!(parse_progress("remote: Enumerating objects: 5, done."), p("Enumerating objects", None));
        assert_eq!(parse_progress("Resolving deltas:   0% (0/12)"), p("Resolving deltas", Some(0)));
        assert_eq!(parse_progress("Writing objects:  33% (1/3)"), p("Writing objects", Some(33)));
        assert_eq!(parse_progress("Updating files: 100% (20/20), done."), p("Updating files", Some(100)));
        assert_eq!(parse_progress("  Counting objects:   7% (7/100)  "), p("Counting objects", Some(7)));
    }

    #[test]
    fn ignores_non_progress_lines() {
        for line in [
            "fatal: Authentication failed for 'https://example.com/repo.git/'",
            "error: failed to push some refs to 'origin'",
            "remote: error: GH006: Protected branch update failed",
            "Cloning into 'grove'...",
            "To C:/tmp/origin.git",
            "   abc123..def456  main -> main",
            "warning: 2 uncommitted changes",
            "remote: Total 3 (delta 0), reused 0 (delta 0), pack-reused 0",
            "",
        ] {
            assert_eq!(parse_progress(line), None, "{line}");
        }
    }

    #[test]
    fn streaming_matches_run() {
        let tmp = tempfile::tempdir().unwrap();
        let never = AtomicBool::new(false);
        let out = run_streaming(tmp.path(), &["init", "-b", "main"], &mut |_| {}, &never, "").unwrap();
        assert!(out.contains("Initialized"), "{out}");
        let err = run_streaming(tmp.path(), &["rev-parse", "nope"], &mut |_| {}, &never, "").unwrap_err();
        assert!(err.message.contains("nope"), "{}", err.message);
    }

    #[test]
    fn cancel_kills_a_blocked_command() {
        let tmp = tempfile::tempdir().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let c2 = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            c2.store(true, Ordering::SeqCst);
        });
        let start = Instant::now();
        // A shell alias that would run for a minute, via git's own sh.
        let err = run_streaming(tmp.path(), &["-c", "alias.wait=!sleep 60", "wait"], &mut |_| {}, &cancel, "").unwrap_err();
        assert_eq!(err.message, "Cancelled.");
        assert!(start.elapsed() < Duration::from_secs(20), "took {:?}", start.elapsed());
    }

    #[test]
    fn ops_register_while_alive() {
        // Not calling cancel_window here: it would also cancel ops in tests
        // running in parallel.
        let op = Op::silent();
        let flag = op.cancel_flag();
        assert!(ACTIVE.lock().unwrap().iter().any(|(c, _)| Arc::ptr_eq(c, &flag)));
        flag.store(true, Ordering::SeqCst);
        assert_eq!(op.run(Path::new("."), &["version"]).unwrap_err().message, "Cancelled.");
        drop(op);
        assert!(!ACTIVE.lock().unwrap().iter().any(|(c, _)| Arc::ptr_eq(c, &flag)));
    }
}
