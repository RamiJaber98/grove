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
};
