//! End to end: git runs the real Grove executable as `GIT_ASKPASS`, which
//! relays the prompts to an in-process askpass server (no GUI involved).

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use grove_lib::askpass::Server;

#[test]
fn git_asks_grove_for_credentials() {
    let prompts: Arc<Mutex<Vec<(String, bool)>>> = Arc::default();
    let slot: Arc<OnceLock<Arc<Server>>> = Arc::new(OnceLock::new());
    let (seen, s2) = (prompts.clone(), slot.clone());
    let server = Server::start(
        move |p| {
            seen.lock().unwrap().push((p.prompt.clone(), p.secret));
            let answer = if p.secret { "hunter 2" } else { "alice" };
            let (id, slot) = (p.id, s2.clone());
            std::thread::spawn(move || slot.get().unwrap().answer(id, Some(answer.into())));
        },
        |_, _| {},
    )
    .unwrap();
    slot.set(server.clone()).ok().unwrap();

    let exe = env!("CARGO_BIN_EXE_grove");
    let mut cmd = Command::new("git");
    // No credential helper, so git has to ask.
    cmd.args(["-c", "credential.helper=", "credential", "fill"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in server.env(exe, "main") {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().unwrap();
    child.stdin.take().unwrap().write_all(b"protocol=https\nhost=example.com\n\n").unwrap();
    let out = child.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(stdout.contains("username=alice\n"), "{stdout}");
    assert!(stdout.contains("password=hunter 2\n"), "{stdout}");

    let prompts = prompts.lock().unwrap();
    assert_eq!(prompts.len(), 2, "{prompts:?}");
    assert!(prompts[0].0.starts_with("Username for 'https://example.com'") && !prompts[0].1);
    assert!(prompts[1].0.starts_with("Password for 'https://alice@example.com'") && prompts[1].1);
}
