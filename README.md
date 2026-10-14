# Grove

A lightweight desktop git GUI for Windows and macOS. Open it in any repository to see staged changes, working-tree changes and stashes, with side-by-side or inline diffs — no IDE required.

Built with [Tauri 2](https://tauri.app) (Rust) and React + TypeScript. All git operations shell out to your installed `git`, so credentials, hooks and config behave exactly as in the terminal.

## Prerequisites

- Node.js 20+
- Rust (via [rustup](https://rustup.rs))
- Git on your `PATH`
- **Windows:** Microsoft C++ Build Tools ("Desktop development with C++") and WebView2 (preinstalled on Windows 11)
- **macOS:** Xcode Command Line Tools (`xcode-select --install`)

## Development

```sh
npm install
npm run app:dev          # run the desktop app with hot reload
npm run app:build        # build installers into src-tauri/target/release/bundle
```

Pass a path to open a repository directly:

```sh
npm run tauri dev -- -- C:/path/to/repo
```

## Layout

```
src/                 React frontend
  api/git.ts         typed wrappers around Tauri commands
  commands.ts        every command id, label and the ⋯ menu layout
  runCommand.ts      dispatcher for native menu, ⋯ menu and panel buttons
  store/             zustand state and persisted preferences
  components/        Workspace, ChangesPanel, DiffView, MoreMenu, StatusBar…
src-tauri/           Rust backend
  src/git/           git process runner and parsers
  src/commands.rs    #[tauri::command] functions exposed to the UI
  src/menu.rs        native application menu
```

## Roadmap

1. ✅ Skeleton — window, layout, native menus, open repository
2. ✅ Status panel — staged / changes, stage, unstage, discard, file watcher
3. ✅ Diff viewer — Monaco diff editor, side-by-side and inline
4. Commit, Push, Pull
5. Stashes
6. ⋯ menu commands — fetch, branches, tags, remotes, reset…
7. History and merge conflicts
8. Polish — settings, shortcuts, installers, auto-update
