# Releasing Grove

Releases are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml) when a `v*` tag is pushed. It runs the frontend tests, then [`tauri-action`](https://github.com/tauri-apps/tauri-action) builds the Windows NSIS installer and a universal macOS app (`.dmg` and `.app`) and attaches them to a **draft** GitHub release.

Every push to `main` and every pull request also runs [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) on Windows, macOS and Linux: `npm run build`, `npm test`, `cargo clippy` (not yet enforced) and `cargo test`. Make sure it's green before tagging.

## 1. Bump the version

The version lives in three places. Keep them identical:

| File | Field |
| --- | --- |
| `package.json` | `"version"` (and run `npm install` so `package-lock.json` follows) |
| `src-tauri/tauri.conf.json` | `"version"`, which is what the installer, the About panel and the updater use |
| `src-tauri/Cargo.toml` | `[package] version` (run `cargo check` in `src-tauri` so `Cargo.lock` follows) |

Commit the bump on `main`:

```sh
git commit -am "Release 0.2.0"
```

## 2. Tag and push

```sh
git tag v0.2.0
git push origin main v0.2.0
```

The tag must match the version (`v` + version). The workflow names the release `Grove v0.2.0`.

## 3. Publish the draft

1. Wait for both matrix jobs (Windows, macOS) of the **Release** workflow to finish.
2. Open **Releases** on GitHub. The new release is a draft with the installers attached.
3. Install and smoke-test the builds, edit the notes, then click **Publish release**.

If a build fails, delete the draft and the tag (`git push --delete origin v0.2.0 && git tag -d v0.2.0`), fix the problem, and tag again.

Until code signing is set up, Windows SmartScreen and macOS Gatekeeper warn on first launch. On macOS, unsigned downloads must be opened with right-click > Open, or allowed under System Settings > Privacy & Security.

## Code signing

Signing is configured entirely through CI secrets and `tauri.conf.json`. Nothing in the app code changes.

### Windows

Either option works. Both sign the app executable and the NSIS installer.

**Option A: Azure Trusted Signing** (cheapest, no hardware token)

1. Create a Trusted Signing account and certificate profile in Azure, and an app registration (service principal) with the *Trusted Signing Certificate Profile Signer* role.
2. Add the repository secrets `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` and `AZURE_TENANT_ID`.
3. In `src-tauri/tauri.conf.json`, add a sign command under `bundle.windows`. Tauri replaces `%1` with the file to sign:

   ```json
   "windows": {
     "signCommand": "trusted-signing-cli -e https://<region>.codesigning.azure.net -a <account> -c <certificate-profile> -d Grove %1",
     "nsis": { "installMode": "currentUser", "installerHooks": "./windows/hooks.nsh" }
   }
   ```

4. In `release.yml`, install the signer before `tauri-action` on Windows (`cargo install trusted-signing-cli`) and pass the three `AZURE_*` secrets as `env` to the `tauri-action` step.

**Option B: an Authenticode certificate (.pfx)**

1. Base64-encode the `.pfx` and store it as `WINDOWS_CERTIFICATE`, and its password as `WINDOWS_CERTIFICATE_PASSWORD`.
2. In `release.yml`, add a Windows-only step before `tauri-action` that imports it into the certificate store:

   ```yaml
   - name: Import code signing certificate
     if: matrix.platform == 'windows-latest'
     shell: pwsh
     run: |
       $bytes = [Convert]::FromBase64String("${{ secrets.WINDOWS_CERTIFICATE }}")
       [IO.File]::WriteAllBytes("cert.pfx", $bytes)
       $password = ConvertTo-SecureString -String "${{ secrets.WINDOWS_CERTIFICATE_PASSWORD }}" -Force -AsPlainText
       Import-PfxCertificate -FilePath cert.pfx -CertStoreLocation Cert:\CurrentUser\My -Password $password
   ```

3. In `tauri.conf.json`, under `bundle.windows`, add:

   ```json
   "certificateThumbprint": "<thumbprint of the certificate>",
   "digestAlgorithm": "sha256",
   "timestampUrl": "http://timestamp.digicert.com"
   ```

An EV certificate gives SmartScreen reputation immediately. With a standard (OV) certificate, the warning goes away once enough people have installed the app.

### macOS (Developer ID + notarization)

1. Join the Apple Developer Program, create a **Developer ID Application** certificate, and export it from Keychain Access as a `.p12` with a password.
2. Create an app-specific password for your Apple ID at appleid.apple.com.
3. Add these repository secrets:

   | Secret | Value |
   | --- | --- |
   | `APPLE_CERTIFICATE` | `base64 -i certificate.p12` output |
   | `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
   | `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
   | `APPLE_ID` | your Apple ID email |
   | `APPLE_PASSWORD` | the app-specific password |
   | `APPLE_TEAM_ID` | your 10-character team ID |

4. Pass them to the `tauri-action` step in `release.yml`:

   ```yaml
   env:
     GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
     APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
     APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
     APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
     APPLE_ID: ${{ secrets.APPLE_ID }}
     APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
     APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
   ```

The Tauri bundler imports the certificate into a temporary keychain, signs the app and DMG, submits them for notarization and staples the ticket. The secrets are only used on the macOS job; the Windows job ignores them.

## Auto-update (ready to enable)

Grove doesn't ship an updater yet, because it needs a signing key pair that only the maintainer should generate. These are the steps to turn it on with [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/), serving updates straight from GitHub releases.

### 1. Generate the update signing key

```sh
npx tauri signer generate -w ~/.tauri/grove.key
```

This prints a **public key** and writes the **private key** to `~/.tauri/grove.key`. Keep the private key and its password safe: if you lose them, installed copies can never be updated again.

Add the repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: the contents of `~/.tauri/grove.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password you chose (empty if none)

### 2. Add the plugin

```sh
npm run tauri add updater     # adds the Rust crate, the npm package and the capability
npm run tauri add process     # for relaunching after an update
```

If you add them by hand instead:

- `src-tauri/Cargo.toml`: `tauri-plugin-updater = "2"` and `tauri-plugin-process = "2"`
- `package.json`: `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process`
- `src-tauri/src/lib.rs`, in the builder: `.plugin(tauri_plugin_updater::Builder::new().build())` and `.plugin(tauri_plugin_process::init())`
- `src-tauri/capabilities/default.json`: add `"updater:default"` and `"process:allow-restart"` to `permissions`

### 3. Configure `tauri.conf.json`

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "<the public key printed in step 1>",
      "endpoints": [
        "https://github.com/<owner>/<repo>/releases/latest/download/latest.json"
      ],
      "windows": { "installMode": "passive" }
    }
  }
}
```

`createUpdaterArtifacts` makes the bundler produce signed update archives (`.nsis.zip`/`.exe` with `.sig` on Windows, `.app.tar.gz` with `.sig` on macOS).

### 4. Sign updates in CI

Pass the key to the `tauri-action` step in `release.yml`:

```yaml
env:
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

With updater artifacts enabled, `tauri-action` also generates `latest.json` (version, notes, and a download URL plus signature per platform) and uploads it to the release. Because GitHub's `releases/latest` URL only resolves to the newest **published** release, users are offered an update only once you publish the draft. After the first signed release, check that `latest.json` lists `windows-x86_64` and both `darwin-aarch64` and `darwin-x86_64` (the universal macOS build should cover both).

### 5. Check for updates in the app

For example, on startup or from an "About" / "Check for Updates…" command:

```ts
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const update = await check();
if (update) {
  // Ask the user first, e.g. with ask() from @tauri-apps/plugin-dialog.
  await update.downloadAndInstall();
  await relaunch();
}
```

Only builds signed with the private key are accepted, so the first release with the updater has to be installed manually; later ones update themselves.
