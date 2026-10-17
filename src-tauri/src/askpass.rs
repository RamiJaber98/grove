//! Credential prompts for git and ssh.
//!
//! Git runs with `GIT_TERMINAL_PROMPT=0` because there is no terminal to
//! prompt on. Instead, network commands point `GIT_ASKPASS`/`SSH_ASKPASS` at
//! Grove's own executable. Launched that way (see `client_main`), Grove
//! doesn't start the GUI: it forwards the prompt over loopback TCP to the
//! running app, which shows a modal and sends back the answer.
//!
//! Wire format, one connection per prompt:
//!   client -> server: `<token>\n<prompt text>` then shuts down its write half
//!   server -> client: `OK\n<answer>` or `CANCEL\n`
//! The token is a per-session random secret passed only through the env of
//! the git child, so other local users/processes can't drive the prompt.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

const PORT_VAR: &str = "GROVE_ASKPASS_PORT";
const TOKEN_VAR: &str = "GROVE_ASKPASS_TOKEN";

/// How long the user has to answer before git is told the prompt failed.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Prompts and tokens are tiny; anything bigger is not our client.
const MAX_REQUEST: u64 = 64 * 1024;

// ---- client (runs in the short-lived askpass process) ----

/// If this process was launched as an askpass helper, answers the prompt and
/// returns the exit code; otherwise returns None and the GUI starts as usual.
pub fn client_main() -> Option<i32> {
    let port: u16 = std::env::var(PORT_VAR).ok()?.parse().ok()?;
    let token = std::env::var(TOKEN_VAR).ok()?;
    // git and ssh pass the prompt as the only argument.
    let prompt = std::env::args().nth(1).unwrap_or_default();
    Some(match request(port, &token, &prompt) {
        Ok(Some(mut answer)) => {
            let mut out = std::io::stdout().lock();
            let ok = writeln!(out, "{answer}").and_then(|_| out.flush()).is_ok();
            wipe(&mut answer);
            if ok {
                0
            } else {
                1
            }
        }
        Ok(None) => 1,
        Err(e) => {
            eprintln!("grove askpass: {e}");
            2
        }
    })
}

/// Sends one prompt to the server and waits for the answer (None = cancelled).
pub fn request(port: u16, token: &str, prompt: &str) -> std::io::Result<Option<String>> {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))?;
    // A little longer than the server's own timeout, so the server decides.
    stream.set_read_timeout(Some(PROMPT_TIMEOUT + Duration::from_secs(30)))?;
    stream.write_all(format!("{token}\n{prompt}").as_bytes())?;
    stream.shutdown(std::net::Shutdown::Write)?;

    let mut reply = Vec::new();
    stream.take(MAX_REQUEST).read_to_end(&mut reply)?;
    let parsed = reply
        .strip_prefix(b"OK\n")
        .map(|answer| String::from_utf8_lossy(answer).into_owned());
    reply.fill(0);
    Ok(parsed)
}

// ---- server (runs inside the GUI) ----

/// What the frontend shows. `secret` masks the input (passwords, passphrases).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub id: u64,
    pub prompt: String,
    pub secret: bool,
}

type Answer = Option<String>;

struct Pending {
    next_id: u64,
    waiting: HashMap<u64, Sender<Answer>>,
}

/// A running listener. `on_prompt` shows a prompt; `on_close` dismisses one
/// that timed out or was cancelled from the backend.
pub struct Server {
    port: u16,
    token: String,
    pending: Mutex<Pending>,
    /// Held for the whole life of a prompt so only one is shown at a time.
    one_at_a_time: Mutex<()>,
    on_prompt: Box<dyn Fn(&Prompt) + Send + Sync>,
    on_close: Box<dyn Fn(u64) + Send + Sync>,
}

impl Server {
    /// Binds a random loopback port and starts accepting on a thread.
    pub fn start(
        on_prompt: impl Fn(&Prompt) + Send + Sync + 'static,
        on_close: impl Fn(u64) + Send + Sync + 'static,
    ) -> std::io::Result<Arc<Server>> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
        let server = Arc::new(Server {
            port: listener.local_addr()?.port(),
            token: new_token()?,
            pending: Mutex::new(Pending { next_id: 1, waiting: HashMap::new() }),
            one_at_a_time: Mutex::new(()),
            on_prompt: Box::new(on_prompt),
            on_close: Box::new(on_close),
        });
        let accept = server.clone();
        std::thread::Builder::new().name("askpass".into()).spawn(move || {
            for stream in listener.incoming().flatten() {
                let server = accept.clone();
                std::thread::spawn(move || server.handle(stream));
            }
        })?;
        Ok(server)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    fn handle(&self, mut stream: TcpStream) {
        // Our client sends everything immediately; don't let a stray
        // connection tie up a thread.
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut raw = Vec::new();
        if (&mut stream).take(MAX_REQUEST).read_to_end(&mut raw).is_err() {
            return;
        }
        let text = String::from_utf8_lossy(&raw).into_owned();
        let Some((token, prompt)) = text.split_once('\n') else { return };
        if !constant_time_eq(token.as_bytes(), self.token.as_bytes()) {
            return;
        }

        let mut answer = self.ask(prompt);
        let reply = match &answer {
            Some(a) => {
                let mut bytes = Vec::with_capacity(a.len() + 3);
                bytes.extend_from_slice(b"OK\n");
                bytes.extend_from_slice(a.as_bytes());
                bytes
            }
            None => b"CANCEL\n".to_vec(),
        };
        let mut reply = reply;
        let _ = stream.write_all(&reply);
        reply.fill(0);
        if let Some(a) = answer.as_mut() {
            wipe(a);
        }
    }

    /// Shows `prompt` and blocks until it is answered, cancelled or times out.
    fn ask(&self, prompt: &str) -> Answer {
        let _turn = self.one_at_a_time.lock().unwrap_or_else(|e| e.into_inner());
        let (tx, rx) = mpsc::channel();
        let id = {
            let mut p = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            let id = p.next_id;
            p.next_id += 1;
            p.waiting.insert(id, tx);
            id
        };
        (self.on_prompt)(&Prompt { id, prompt: prompt.to_string(), secret: is_secret(prompt) });
        let answer = rx.recv_timeout(PROMPT_TIMEOUT).ok().flatten();
        // Still registered means nobody answered: close the dialog.
        let unanswered = self.pending.lock().unwrap_or_else(|e| e.into_inner()).waiting.remove(&id).is_some();
        if unanswered {
            (self.on_close)(id);
        }
        answer
    }

    /// Delivers the user's answer (None = cancelled) for prompt `id`.
    pub fn answer(&self, id: u64, answer: Answer) {
        let tx = self.pending.lock().unwrap_or_else(|e| e.into_inner()).waiting.remove(&id);
        if let Some(tx) = tx {
            let _ = tx.send(answer);
        }
    }

    /// Cancels every open prompt (the git operation itself was cancelled).
    pub fn cancel_all(&self) {
        let ids: Vec<u64> = self.pending.lock().unwrap_or_else(|e| e.into_inner()).waiting.keys().copied().collect();
        for id in ids {
            self.answer(id, None);
            (self.on_close)(id);
        }
    }

    /// Env vars that make git and ssh ask Grove for credentials.
    pub fn env(&self, exe: &str) -> Vec<(&'static str, String)> {
        vec![
            ("GIT_ASKPASS", exe.to_string()),
            ("SSH_ASKPASS", exe.to_string()),
            // OpenSSH >= 8.4: use askpass even though a console may exist.
            ("SSH_ASKPASS_REQUIRE", "force".to_string()),
            (PORT_VAR, self.port.to_string()),
            (TOKEN_VAR, self.token.clone()),
        ]
    }
}

/// The app-wide server, started on the first network operation.
static SERVER: OnceLock<Arc<Server>> = OnceLock::new();

/// Starts the app-wide server if needed. Failure only means prompts aren't
/// available, so git falls back to failing with its own message.
pub fn ensure_started(
    on_prompt: impl Fn(&Prompt) + Send + Sync + 'static,
    on_close: impl Fn(u64) + Send + Sync + 'static,
) {
    if SERVER.get().is_some() {
        return;
    }
    match Server::start(on_prompt, on_close) {
        Ok(server) => {
            let _ = SERVER.set(server);
        }
        Err(e) => eprintln!("askpass unavailable: {e}"),
    }
}

pub fn global() -> Option<&'static Arc<Server>> {
    SERVER.get()
}

/// Adds askpass env vars to a git command, if the server is running.
pub fn configure(cmd: &mut std::process::Command) {
    let Some(server) = global() else { return };
    let Some(exe) = exe_path() else { return };
    for (k, v) in server.env(&exe) {
        cmd.env(k, v);
    }
    // Some ssh builds ignore SSH_ASKPASS unless DISPLAY is set.
    if std::env::var_os("DISPLAY").is_none() {
        cmd.env("DISPLAY", ":0");
    }
}

/// Grove's own executable. Forward slashes so both git and the MSYS ssh
/// bundled with Git for Windows accept the path.
fn exe_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let s = exe.to_string_lossy().into_owned();
    Some(if cfg!(windows) { s.replace('\\', "/") } else { s })
}

/// Passwords, passphrases, PINs and tokens are masked; usernames and ssh's
/// host-key "yes/no" question are not.
fn is_secret(prompt: &str) -> bool {
    let p = prompt.to_ascii_lowercase();
    ["password", "passphrase", "pin", "token", "passcode"].iter().any(|w| p.contains(w))
        && !p.contains("username")
}

fn new_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Overwrites a secret before its memory is freed.
fn wipe(s: &mut String) {
    // SAFETY: zero bytes are valid UTF-8.
    unsafe { s.as_mut_vec().fill(0) };
    std::hint::black_box(&s);
    s.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A server whose "frontend" answers every prompt with `reply(prompt)`.
    fn server(reply: impl Fn(&str) -> Answer + Send + Sync + 'static) -> Arc<Server> {
        let slot: Arc<OnceLock<Arc<Server>>> = Arc::new(OnceLock::new());
        let s2 = slot.clone();
        let server = Server::start(
            move |p| {
                let (id, answer, slot) = (p.id, reply(&p.prompt), s2.clone());
                // Answer from another thread, like the real UI does.
                std::thread::spawn(move || slot.get().unwrap().answer(id, answer));
            },
            |_| {},
        )
        .unwrap();
        slot.set(server.clone()).ok().unwrap();
        server
    }

    #[test]
    fn round_trip() {
        let s = server(|p| (p == "Password for 'https://x@host': ").then(|| "s3cr3t pw".to_string()));
        assert_eq!(request(s.port(), s.token(), "Password for 'https://x@host': ").unwrap().as_deref(), Some("s3cr3t pw"));
        assert_eq!(request(s.port(), s.token(), "Username for 'https://host': ").unwrap(), None, "cancelled");
    }

    #[test]
    fn multi_line_prompt_and_unicode() {
        let s = server(|p| Some(format!("{}|ü", p.lines().count())));
        let prompt = "The authenticity of host 'h' can't be established.\nAre you sure (yes/no)? ";
        assert_eq!(request(s.port(), s.token(), prompt).unwrap().as_deref(), Some("2|ü"));
    }

    #[test]
    fn wrong_token_is_rejected() {
        let s = server(|_| Some("leak".into()));
        let mut bad = s.token().to_string();
        bad.replace_range(0..1, if bad.starts_with('0') { "1" } else { "0" });
        assert_eq!(request(s.port(), &bad, "Password: ").unwrap(), None);
        assert_eq!(request(s.port(), "", "Password: ").unwrap(), None);
    }

    #[test]
    fn backend_cancel_unblocks_client() {
        let seen: Arc<Mutex<Vec<u64>>> = Arc::default();
        let seen2 = seen.clone();
        let s = Server::start(move |p| seen2.lock().unwrap().push(p.id), |_| {}).unwrap();
        let (port, token) = (s.port(), s.token().to_string());
        let t = std::thread::spawn(move || request(port, &token, "Passphrase: ").unwrap());
        // Wait for the prompt to be shown, then cancel it from the backend.
        while seen.lock().unwrap().is_empty() {
            std::thread::sleep(Duration::from_millis(10));
        }
        s.cancel_all();
        assert_eq!(t.join().unwrap(), None);
    }

    #[test]
    fn secret_detection() {
        assert!(is_secret("Password for 'https://u@github.com': "));
        assert!(is_secret("Enter passphrase for key '/c/Users/x/.ssh/id_ed25519': "));
        assert!(!is_secret("Username for 'https://github.com': "));
        assert!(!is_secret("Are you sure you want to continue connecting (yes/no/[fingerprint])? "));
    }

    #[test]
    fn wipe_clears() {
        let mut s = "secret".to_string();
        wipe(&mut s);
        assert!(s.is_empty());
    }
}
