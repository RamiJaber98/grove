/**
 * Every user-facing command, keyed by the id used in the native menu
 * (src-tauri/src/menu.rs) and the ⋯ menu.
 */
export interface CommandInfo {
  label: string;
  danger?: boolean;
}

export const COMMANDS: Record<string, CommandInfo> = {
  // File
  open_repo: { label: "Open Repository…" },
  clone_repo: { label: "Clone Repository…" },
  init_repo: { label: "Initialize Repository…" },
  open_in_explorer: { label: "Open in File Explorer" },
  open_terminal: { label: "Open Terminal Here" },
  settings: { label: "Settings" },
  close_repo: { label: "Close Repository" },

  // Edit / View
  find: { label: "Find in Diff" },
  next_change: { label: "Next Change" },
  prev_change: { label: "Previous Change" },
  diff_side_by_side: { label: "Side-by-Side Diff" },
  diff_inline: { label: "Inline Diff" },
  toggle_whitespace: { label: "Ignore Whitespace" },
  toggle_word_wrap: { label: "Word Wrap" },
  theme_system: { label: "System Theme" },
  theme_light: { label: "Light Theme" },
  theme_dark: { label: "Dark Theme" },
  show_history: { label: "History" },
  refresh: { label: "Refresh" },

  // Primary actions (panel buttons)
  commit: { label: "Commit" },
  push: { label: "Push" },
  pull: { label: "Pull" },

  // Sync
  fetch: { label: "Fetch" },
  fetch_prune: { label: "Fetch (Prune)" },
  fetch_all: { label: "Fetch From All Remotes" },
  sync: { label: "Sync (Pull then Push)" },
  pull_rebase: { label: "Pull (Rebase)" },
  push_force: { label: "Push (Force With Lease)", danger: true },

  // Commit
  commit_amend: { label: "Amend Last Commit" },
  undo_commit: { label: "Undo Last Commit" },

  // Changes
  stage_all: { label: "Stage All Changes" },
  unstage_all: { label: "Unstage All Changes" },
  discard_all: { label: "Discard All Changes", danger: true },
  clean_untracked: { label: "Delete Untracked Files", danger: true },

  // Stash
  stash: { label: "Stash" },
  stash_untracked: { label: "Stash (Include Untracked)" },
  stash_staged: { label: "Stash Staged Changes" },
  stash_apply: { label: "Apply Latest Stash" },
  stash_pop: { label: "Pop Latest Stash" },
  stash_drop: { label: "Drop Stash…", danger: true },

  // Branch
  checkout_branch: { label: "Checkout…" },
  new_branch: { label: "New Branch…" },
  rename_branch: { label: "Rename Branch…" },
  merge_branch: { label: "Merge Into Current…" },
  rebase_branch: { label: "Rebase Current Onto…" },
  delete_branch: { label: "Delete Branch…", danger: true },
  compare_refs: { label: "Compare…" }, // compare refs

  // Tags
  add_tag: { label: "Create Tag…" },
  delete_tag: { label: "Delete Tag…", danger: true },
  push_tags: { label: "Push Tags" },

  // Remotes
  manage_remotes: { label: "Remotes…" },
  add_remote: { label: "Add Remote…" },
  remove_remote: { label: "Remove Remote…", danger: true },

  // History / advanced
  cherry_pick: { label: "Cherry-Pick…" },
  revert_commit: { label: "Revert Commit…" },
  reset_soft: { label: "Reset (Soft)…" },
  reset_mixed: { label: "Reset (Mixed)…" },
  reset_hard: { label: "Reset (Hard)…", danger: true },

  // Repository
  edit_gitignore: { label: "Edit .gitignore" },
  edit_git_config: { label: "Git Identity" },

  // File history and blame (act on the file selected in the diff)
  file_history: { label: "File History" },
  blame_file: { label: "Blame" },

  // Help
  shortcuts: { label: "Keyboard Shortcuts" },
  about: { label: "About Grove" },

  // Partial staging (hunks and lines), acting on the open diff
  stage_hunk: { label: "Stage Hunk" },
  stage_lines: { label: "Stage Selected Lines" },
  unstage_hunk: { label: "Unstage Hunk" },
  unstage_lines: { label: "Unstage Selected Lines" },
  discard_hunk: { label: "Discard Hunk", danger: true },
  discard_lines: { label: "Discard Selected Lines", danger: true },
};

/** Layout of the ⋯ menu. Push, Pull and Commit are deliberately absent. */
export const MORE_MENU: { title: string; ids: string[] }[] = [
  { title: "Sync", ids: ["fetch", "fetch_prune", "fetch_all", "sync", "pull_rebase", "push_force"] },
  { title: "Commit", ids: ["commit_amend", "undo_commit"] },
  { title: "Changes", ids: ["stage_all", "unstage_all", "discard_all", "clean_untracked"] },
  { title: "Stash", ids: ["stash", "stash_untracked", "stash_staged", "stash_apply", "stash_pop", "stash_drop"] },
  { title: "Branch", ids: ["checkout_branch", "new_branch", "rename_branch", "merge_branch", "rebase_branch", "delete_branch", "compare_refs"] },
  { title: "Tags", ids: ["add_tag", "delete_tag", "push_tags"] },
  { title: "Remote", ids: ["add_remote", "remove_remote"] },
  { title: "Reset & History", ids: ["cherry_pick", "revert_commit", "reset_soft", "reset_mixed", "reset_hard"] },
];

// Interactive rebase: listed right after "Rebase Current Onto…".
COMMANDS.interactive_rebase = { label: "Interactive Rebase…" };
{
  const ids = MORE_MENU.find((g) => g.title === "Branch")?.ids;
  ids?.splice(ids.indexOf("rebase_branch") + 1, 0, "interactive_rebase");
}
