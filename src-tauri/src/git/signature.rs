//! Commit signature status. Verifying runs gpg / ssh-keygen, so it's only
//! asked for one commit at a time (the detail pane), never for the log.

use std::path::Path;

use serde::Serialize;

use super::run;

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    /// git's `%G?`: G good, B bad, U good but untrusted key, X expired
    /// signature, Y expired key, R revoked key, E can't be checked (missing
    /// key or tool), N not signed.
    pub status: char,
    /// Who signed it (`%GS`), when known.
    pub signer: String,
    /// Key id or fingerprint (`%GK`).
    pub key: String,
}

fn parse(out: &str) -> Signature {
    let mut f = out.trim_end_matches('\n').splitn(3, '\0');
    let status = f.next().and_then(|s| s.chars().next()).filter(|c| "GBUXYREN".contains(*c)).unwrap_or('N');
    Signature {
        status,
        signer: f.next().unwrap_or_default().trim().to_string(),
        key: f.next().unwrap_or_default().trim().to_string(),
    }
}

/// `hash` must already be validated. A failure to verify is reported as
/// "can't check" rather than failing the whole detail view.
pub fn signature(root: &Path, hash: &str) -> Signature {
    match run(root, &["show", "-s", "--format=%G?%x00%GS%x00%GK", hash]) {
        Ok(out) => parse(&out),
        Err(_) => Signature { status: 'E', ..Default::default() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status() {
        assert_eq!(parse("N\0\0\n"), Signature { status: 'N', ..Default::default() });
        let s = parse("G\0Tess <t@example.com>\0ABCDEF0123\n");
        assert_eq!((s.status, s.signer.as_str(), s.key.as_str()), ('G', "Tess <t@example.com>", "ABCDEF0123"));
        assert_eq!(parse("U\0x\0k").status, 'U');
        assert_eq!(parse("").status, 'N');
        assert_eq!(parse("?\0\0").status, 'N');
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "Tess"],
            &["config", "commit.gpgsign", "false"],
        ] {
            run(dir.path(), args).unwrap();
        }
        dir
    }

    #[test]
    fn unsigned_and_ssh_signed_commits() {
        let dir = repo();
        let root = dir.path();
        run(root, &["commit", "--allow-empty", "-qm", "plain"]).unwrap();
        assert_eq!(signature(root, "HEAD").status, 'N');

        // SSH signing needs only ssh-keygen; skip the signed half without it.
        let key = root.join("key");
        let keygen = std::process::Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-C", "t@example.com", "-f"])
            .arg(&key)
            .output();
        if !keygen.is_ok_and(|o| o.status.success()) {
            eprintln!("ssh-keygen unavailable; skipping signed-commit check");
            return;
        }
        let public = std::fs::read_to_string(root.join("key.pub")).unwrap();
        std::fs::write(root.join("allowed"), format!("t@example.com {public}")).unwrap();
        let key = key.to_string_lossy().replace('\\', "/");
        let allowed = root.join("allowed").to_string_lossy().replace('\\', "/");
        for args in [
            &["config", "gpg.format", "ssh"][..],
            &["config", "user.signingkey", &key],
            &["config", "gpg.ssh.allowedSignersFile", &allowed],
        ] {
            run(root, args).unwrap();
        }
        if run(root, &["commit", "--allow-empty", "-S", "-qm", "signed"]).is_err() {
            eprintln!("ssh signing failed on this machine; skipping signed-commit check");
            return;
        }
        let s = signature(root, "HEAD");
        assert_eq!(s.status, 'G', "{s:?}");
        assert!(s.signer.contains("t@example.com"));
        assert_eq!(signature(root, "HEAD~1").status, 'N');
    }
}
