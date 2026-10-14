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
}

export interface StashEntry {
  /** e.g. "stash@{0}" */
  ref: string;
  message: string;
  files: FileChange[];
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
};
