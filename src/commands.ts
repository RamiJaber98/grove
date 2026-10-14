/**
 * Every user-facing command, keyed by the id used in the native menu
 * (src-tauri/src/menu.rs) and the ⋯ menu. `phase` marks commands that are
 * planned but not wired up yet; running one shows a notice instead.
 */
export interface CommandInfo {
  label: string;
  phase?: number;
  danger?: boolean;
}

export const COMMANDS: Record<string, CommandInfo> = {
  // File
  open_repo: { label: "Open Repository…" },
  clone_repo: { label: "Clone Repository", phase: 8 },
  init_repo: { label: "Initialize Repository", phase: 8 },
  open_in_explorer: { label: "Open in File Explorer", phase: 8 },
  open_terminal: { label: "Open Terminal Here", phase: 8 },
  settings: { label: "Settings", phase: 8 },
  close_repo: { label: "Close Repository" },

  // Edit / View
  find: { label: "Find in Diff", phase: 3 },
  diff_side_by_side: { label: "Side-by-Side Diff" },
  diff_inline: { label: "Inline Diff" },
  toggle_whitespace: { label: "Ignore Whitespace" },
  toggle_word_wrap: { label: "Word Wrap" },
  theme_system: { label: "System Theme" },
  theme_light: { label: "Light Theme" },
  theme_dark: { label: "Dark Theme" },
  show_history: { label: "History", phase: 7 },
  refresh: { label: "Refresh" },

  // Primary actions (panel buttons)
  commit: { label: "Commit", phase: 4 },
  push: { label: "Push", phase: 4 },
  pull: { label: "Pull", phase: 4 },

  // Sync
  fetch: { label: "Fetch", phase: 6 },
  fetch_prune: { label: "Fetch (Prune)", phase: 6 },
  fetch_all: { label: "Fetch From All Remotes", phase: 6 },
  sync: { label: "Sync (Pull then Push)", phase: 6 },
  pull_rebase: { label: "Pull (Rebase)", phase: 6 },
  push_force: { label: "Push (Force With Lease)", phase: 6, danger: true },

  // Commit
  commit_amend: { label: "Amend Last Commit", phase: 4 },
  undo_commit: { label: "Undo Last Commit", phase: 6 },

  // Changes
  stage_all: { label: "Stage All Changes", phase: 2 },
  unstage_all: { label: "Unstage All Changes", phase: 2 },
  discard_all: { label: "Discard All Changes", phase: 2, danger: true },
  clean_untracked: { label: "Delete Untracked Files", phase: 6, danger: true },

  // Stash
  stash: { label: "Stash", phase: 5 },
  stash_untracked: { label: "Stash (Include Untracked)", phase: 5 },
  stash_staged: { label: "Stash Staged Only", phase: 5 },
  stash_apply: { label: "Apply Latest Stash", phase: 5 },
  stash_pop: { label: "Pop Latest Stash", phase: 5 },
  stash_drop: { label: "Drop Stash…", phase: 5, danger: true },

  // Branch
  checkout_branch: { label: "Checkout…", phase: 6 },
  new_branch: { label: "New Branch…", phase: 6 },
  rename_branch: { label: "Rename Branch…", phase: 6 },
  merge_branch: { label: "Merge Into Current…", phase: 6 },
  rebase_branch: { label: "Rebase Current Onto…", phase: 6 },
  delete_branch: { label: "Delete Branch…", phase: 6, danger: true },

  // Tags
  add_tag: { label: "Create Tag…", phase: 6 },
  delete_tag: { label: "Delete Tag…", phase: 6, danger: true },
  push_tags: { label: "Push Tags", phase: 6 },

  // Remotes
  manage_remotes: { label: "Remotes…", phase: 6 },
  add_remote: { label: "Add Remote…", phase: 6 },
  remove_remote: { label: "Remove Remote…", phase: 6, danger: true },

  // History / advanced
  cherry_pick: { label: "Cherry-Pick…", phase: 7 },
  revert_commit: { label: "Revert Commit…", phase: 7 },
  reset_soft: { label: "Reset (Soft)…", phase: 6 },
  reset_mixed: { label: "Reset (Mixed)…", phase: 6 },
  reset_hard: { label: "Reset (Hard)…", phase: 6, danger: true },

  // Repository
  edit_gitignore: { label: "Edit .gitignore", phase: 8 },
  edit_git_config: { label: "Git Identity", phase: 8 },

  // Help
  shortcuts: { label: "Keyboard Shortcuts", phase: 8 },
  check_updates: { label: "Check for Updates", phase: 8 },
  about: { label: "About Grove" },
};

/** Layout of the ⋯ menu. Push, Pull and Commit are deliberately absent. */
export const MORE_MENU: { title: string; ids: string[] }[] = [
  { title: "Sync", ids: ["fetch", "fetch_prune", "fetch_all", "sync", "pull_rebase", "push_force"] },
  { title: "Commit", ids: ["commit_amend", "undo_commit"] },
  { title: "Changes", ids: ["stage_all", "unstage_all", "discard_all", "clean_untracked"] },
  { title: "Stash", ids: ["stash", "stash_untracked", "stash_staged", "stash_apply", "stash_pop", "stash_drop"] },
  { title: "Branch", ids: ["checkout_branch", "new_branch", "rename_branch", "merge_branch", "rebase_branch", "delete_branch"] },
  { title: "Tags", ids: ["add_tag", "delete_tag", "push_tags"] },
  { title: "Remote", ids: ["add_remote", "remove_remote"] },
  { title: "Reset & History", ids: ["cherry_pick", "revert_commit", "reset_soft", "reset_mixed", "reset_hard"] },
];
