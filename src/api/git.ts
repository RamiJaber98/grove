import { invoke } from "@tauri-apps/api/core";

export interface RepoInfo {
  root: string;
  name: string;
}

/** Status letters as shown in the panel (mirrors VS / VS Code). U = untracked, ! = conflicted. */
export type ChangeKind = "M" | "A" | "D" | "R" | "C" | "U" | "!";

export interface FileChange {
  path: string;
  kind: ChangeKind;
  /** Original path for renames. */
  from?: string;
}

export interface Status {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasCommits: boolean;
  staged: FileChange[];
  changes: FileChange[];
  conflicts: FileChange[];
  /** In-progress multi-step operation, if any. */
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
}

export interface Branch {
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  hash: string;
  subject: string;
  time: number;
}

export interface Tag {
  name: string;
  subject: string;
}

export interface Remote {
  name: string;
  url: string;
}

export interface Commit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  time: number;
}

export type ResetMode = "soft" | "mixed" | "hard";

export interface LogEntry {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  time: number;
  /** e.g. "HEAD -> main", "origin/main", "tag: v1.0" */
  refs: string[];
  subject: string;
}

export interface CommitDetail {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  committer: string;
  commitTime: number;
  message: string;
  files: FileChange[];
}

export interface Identity {
  name: string;
  email: string;
  /** True when this repo overrides the global identity. */
  local: boolean;
}

export interface StashEntry {
  /** e.g. "stash@{0}" */
  ref: string;
  message: string;
  branch: string | null;
  /** Unix seconds. */
  time: number;
  files: FileChange[];
}

export type StashMode = "tracked" | "include_untracked" | "staged";

export interface Side {
  exists: boolean;
  binary: boolean;
  tooLarge: boolean;
  size: number;
  text: string;
}

export interface FileVersions {
  original: Side;
  modified: Side;
}

export interface GitError {
  message: string;
}

export const isTauri = "__TAURI_INTERNALS__" in window;

/** Normalises errors from invoke() (which rejects with the serialised GitError). */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as GitError).message);
  return String(e);
}

export type RemoteOp =
  | "fetch"
  | "fetch_prune"
  | "fetch_all"
  | "pull"
  | "pull_rebase"
  | "push"
  | "push_force"
  | "push_tags"
  | "sync";

export const git = {
  launchPath: () => invoke<string | null>("launch_path"),
  openRepo: (path: string) => invoke<RepoInfo>("open_repo", { path }),
  closeRepo: () => invoke<void>("close_repo"),
  status: (root: string) => invoke<Status>("status", { root }),
  stage: (root: string, paths: string[]) => invoke<void>("stage", { root, paths }),
  unstage: (root: string, paths: string[]) => invoke<void>("unstage", { root, paths }),
  unstageAll: (root: string) => invoke<void>("unstage_all", { root }),
  discard: (root: string, tracked: string[], untracked: string[]) =>
    invoke<void>("discard", { root, tracked, untracked }),
  /** `rev` is the stash ref or commit hash for the "stash" and "commit" groups. */
  fileVersions: (root: string, group: string, path: string, from?: string, rev?: string) =>
    invoke<FileVersions>("file_versions", { root, group, path, from, rev }),
  /** Returns the new commit's short hash. */
  commit: (root: string, message: string, amend: boolean) => invoke<string>("commit", { root, message, amend }),
  lastCommitMessage: (root: string) => invoke<string | null>("last_commit_message", { root }),
  /** Returns the undone commit's message. */
  undoLastCommit: (root: string) => invoke<string>("undo_last_commit", { root }),
  /** Returns a one-line summary of what happened. */
  remoteOp: (root: string, op: RemoteOp) => invoke<string>("remote_op", { root, op }),
  stashList: (root: string) => invoke<StashEntry[]>("stash_list", { root }),
  stashPush: (root: string, message: string, mode: StashMode) =>
    invoke<void>("stash_push", { root, message, mode }),
  stashApply: (root: string, stashRef: string, pop: boolean) =>
    invoke<void>("stash_apply", { root, stashRef, pop }),
  stashDrop: (root: string, stashRef: string) => invoke<void>("stash_drop", { root, stashRef }),
  branches: (root: string) => invoke<Branch[]>("branches", { root }),
  /** Returns the local branch name that's now checked out. */
  checkout: (root: string, name: string, remote: boolean) => invoke<string>("checkout", { root, name, remote }),
  createBranch: (root: string, name: string, start: string | null, switchTo: boolean) =>
    invoke<void>("create_branch", { root, name, start, switch: switchTo }),
  renameBranch: (root: string, old: string, newName: string) =>
    invoke<void>("rename_branch", { root, old, new: newName }),
  deleteBranch: (root: string, name: string, force: boolean) => invoke<void>("delete_branch", { root, name, force }),
  merge: (root: string, name: string) => invoke<string>("merge", { root, name }),
  rebase: (root: string, onto: string) => invoke<string>("rebase", { root, onto }),
  operation: (root: string, kind: string, action: "abort" | "continue") =>
    invoke<void>("operation", { root, kind, action }),
  tags: (root: string) => invoke<Tag[]>("tags", { root }),
  createTag: (root: string, name: string, message: string, target: string | null = null) =>
    invoke<void>("create_tag", { root, name, message, target }),
  deleteTag: (root: string, name: string) => invoke<void>("delete_tag", { root, name }),
  remotes: (root: string) => invoke<Remote[]>("remotes", { root }),
  addRemote: (root: string, name: string, url: string) => invoke<void>("add_remote", { root, name, url }),
  removeRemote: (root: string, name: string) => invoke<void>("remove_remote", { root, name }),
  reset: (root: string, target: string, mode: ResetMode) => invoke<void>("reset", { root, target, mode }),
  /** Returns how many paths were deleted. */
  clean: (root: string) => invoke<number>("clean", { root }),
  recentCommits: (root: string, limit: number) => invoke<Commit[]>("recent_commits", { root, limit }),
  log: (root: string, skip: number, limit: number, all: boolean) => invoke<LogEntry[]>("log", { root, skip, limit, all }),
  commitDetail: (root: string, hash: string) => invoke<CommitDetail>("commit_detail", { root, hash }),
  cherryPick: (root: string, hash: string) => invoke<void>("cherry_pick", { root, hash }),
  revert: (root: string, hash: string) => invoke<void>("revert", { root, hash }),
  checkoutDetached: (root: string, hash: string) => invoke<void>("checkout_detached", { root, hash }),
  /** Returns the path of the new clone. */
  cloneRepo: (url: string, parent: string) => invoke<string>("clone_repo", { url, parent }),
  initRepo: (path: string) => invoke<void>("init_repo", { path }),
  identity: (root: string) => invoke<Identity>("identity", { root }),
  setIdentity: (root: string, name: string, email: string, global: boolean) =>
    invoke<void>("set_identity", { root, name, email, global }),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  openTerminal: (path: string) => invoke<void>("open_terminal", { path }),
  openRepoFile: (root: string, path: string, create: boolean) => invoke<void>("open_repo_file", { root, path, create }),
  // Merge conflict editor
  conflictFile: (root: string, path: string) => invoke<ConflictFile>("conflict_file", { root, path }),
  /** Writes the resolved text (keeping the file's line endings); `stage` marks it resolved. */
  saveConflict: (root: string, path: string, content: string, stage: boolean) =>
    invoke<void>("save_conflict", { root, path, content, stage }),
  /** Takes one side wholesale (or deletes the file) and stages the result. */
  resolveConflict: (root: string, path: string, resolution: Resolution) =>
    invoke<void>("resolve_conflict", { root, path, resolution }),
  // History search and compare
  searchLog: (root: string, query: LogQuery) => invoke<LogEntry[]>("search_log", { root, query }),
  /** `b` of null compares with the working tree. */
  compare: (root: string, a: string, b: string | null, threeDot: boolean) =>
    invoke<Comparison>("compare", { root, a, b, threeDot }),
  /** `head` of null reads the file on disk. */
  refVersions: (root: string, base: string, head: string | null, path: string, from?: string) =>
    invoke<FileVersions>("ref_versions", { root, base, head, path, from }),
};

// ---- Credential prompts, progress & cancel (network operations) ----

/** `git-progress` event: the current phase of a clone/fetch/pull/push. */
export interface GitProgress {
  phase: string;
  /** Null for phases git reports as a bare count. */
  percent: number | null;
}

/** `askpass` event: git or ssh needs a username, password or passphrase. */
export interface AskpassPrompt {
  id: number;
  prompt: string;
  /** Mask the input (passwords, passphrases). */
  secret: boolean;
}

export const network = {
  /** Kills the running network operation and closes its credential prompt. */
  cancel: () => invoke<void>("cancel_git"),
  /** Answers a credential prompt; null cancels it. */
  answerPrompt: (id: number, answer: string | null) => invoke<void>("askpass_answer", { id, answer }),
};

// Merge conflict editor

/** UU both modified, AA both added, DU deleted by us, UD deleted by them, AU/UA added by one side, DD both deleted. */
export type ConflictCode = "UU" | "AA" | "DU" | "UD" | "AU" | "UA" | "DD";
export type Resolution = "ours" | "theirs" | "delete";

export interface ConflictFile {
  code: ConflictCode;
  base: Side;
  ours: Side;
  theirs: Side;
  working: Side;
  /** False when the working file isn't UTF-8 and can't be edited as text. */
  utf8: boolean;
  /** Who "ours" and "theirs" are; see sideLabels() in conflicts.ts. */
  context: import("../conflicts").ConflictContext;
}

// ── History search and compare ──────────────────────────────────────────

/** Filters for `searchLog`; empty fields are ignored. Dates are YYYY-MM-DD. */
export interface LogQuery {
  skip: number;
  limit: number;
  all?: boolean;
  rev?: string;
  message?: string;
  author?: string;
  path?: string;
  since?: string;
  until?: string;
  /** Hash prefix: returns just that commit, or nothing. */
  hash?: string;
}

export interface CompareFile {
  path: string;
  kind: ChangeKind;
  from?: string | null;
  /** Null for binary files. */
  added: number | null;
  removed: number | null;
}

export interface Comparison {
  /** Full hash of the left side (A, or the merge base for three-dot). */
  base: string;
  /** Full hash of B; null for the working tree. */
  head: string | null;
  files: CompareFile[];
  /** Commits in B not in A. */
  ahead: LogEntry[];
  /** Commits in A not in B. */
  behind: LogEntry[];
}
