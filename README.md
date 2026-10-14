# Grove

A lightweight desktop git GUI for Windows and macOS. Open it in any repository to see staged changes, working-tree changes and stashes, with side-by-side or inline diffs — no IDE required.

Built with [Tauri 2](https://tauri.app) (Rust) and React + TypeScript. All git operations shell out to your installed `git`, so credentials, hooks and config behave exactly as in the terminal.

## Using Grove

- **Open a repository:** File › Open Repository, the recent list on the start screen, or from a terminal:
  ```sh
  grove .
  ```
- **Windows:** the installer adds the `grove` command and an **Open in Grove** entry to Explorer's right-click menu (on folders and inside an open folder). Both are removed on uninstall.
- **macOS:** to get the `grove` command, link the app's binary onto your PATH once:
  ```sh
  ln -s /Applications/Grove.app/Contents/MacOS/grove /usr/local/bin/grove
  ```

The right panel holds **Commit**, **Push** and **Pull**, plus the **⋯** menu with every other git command (fetch, stash, branches, tags, remotes, reset, cherry-pick…). The **History** tab shows the commit graph. Press <kbd>Ctrl</kbd>+<kbd>/</kbd> (<kbd>⌘</kbd>+<kbd>/</kbd> on macOS) for all keyboard shortcuts.

## Prerequisites (development)

- Node.js 20+
- Rust (via [rustup](https://rustup.rs))
- Git on your `PATH`
- **Windows:** Microsoft C++ Build Tools ("Desktop development with C++") and WebView2 (preinstalled on Windows 11)
- **macOS:** Xcode Command Line Tools (`xcode-select --install`)

## Development

```sh
npm install
npm run app:dev          # run the desktop app with hot reload
npm run app:build        # build the installer into src-tauri/target/release/bundle
cd src-tauri && cargo test   # backend tests (run real git in temp repos)
```

Pass a path to open a repository directly:

```sh
npm run tauri dev -- -- C:/path/to/repo
```

> **Windows Smart App Control:** if it's enabled, Windows may occasionally refuse to run freshly built binaries ("An Application Control policy has blocked this file", os error 4551). That's the OS blocking unsigned executables, not a build error; a later build usually runs.

## Releasing

Push a version tag and GitHub Actions builds the Windows installer and a universal macOS app, attached to a draft release:

```sh
git tag v0.2.0
git push origin v0.2.0
```

Bump `version` in `package.json` and `src-tauri/tauri.conf.json` first. The builds are unsigned, so Windows SmartScreen and macOS Gatekeeper will warn on first launch until code signing is set up.

## Layout

```
src/                 React frontend
  api/git.ts         typed wrappers around Tauri commands
  commands.ts        every command id, label and the ⋯ menu layout
  runCommand.ts      dispatcher for native menu, ⋯ menu, shortcuts and buttons
  actions.ts         commit / push / pull / stash flows
  refActions.ts      branch, tag, remote, reset and history flows
  repoActions.ts     clone, init, and OS hand-offs
  shortcuts.ts       keyboard shortcuts
  graph.ts           commit-graph lane layout
  monaco.ts          trimmed, locally bundled Monaco editor
  store/             zustand state and persisted preferences
  components/        Workspace, ChangesPanel, DiffView, HistoryView, dialogs…
src-tauri/           Rust backend
  src/git/           git process runner, parsers and operations (with tests)
  src/commands.rs    #[tauri::command] functions exposed to the UI
  src/menu.rs        native application menu
  src/watcher.rs     file watcher that keeps the panel live
  src/system.rs      file manager, terminal and default-app hand-offs
  windows/hooks.nsh  installer hooks (context menu, `grove` command)
```

## Roadmap

1. ✅ Skeleton — window, layout, native menus, open repository
2. ✅ Status panel — staged / changes, stage, unstage, discard, file watcher
3. ✅ Diff viewer — Monaco diff editor, side-by-side and inline
4. ✅ Commit, Push, Pull (plus fetch, sync, amend, undo, force push)
5. ✅ Stashes
6. ✅ ⋯ menu commands — fetch, branches, tags, remotes, reset…
7. ✅ History and merge conflicts
8. ✅ Polish — settings, shortcuts, clone/init, Explorer integration, installers

Not yet: code signing and auto-update (both need a signing key and a place to host releases).
