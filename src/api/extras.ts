/** Backend calls for the extras: images, remote branches, submodules, worktrees, LFS, windows. */
import { invoke } from "@tauri-apps/api/core";

export interface ImageSide {
  exists: boolean;
  tooLarge: boolean;
  size: number;
  mime: string;
  /** Base64 file content; empty when not sent. */
  data: string;
  /** Set when this side is an LFS pointer without local content: the real size. */
  lfsSize?: number;
}

export interface ImageVersions {
  original: ImageSide;
  modified: ImageSide;
}

/** git's %G?: G good, B bad, U untrusted, X/Y expired, R revoked, E can't check, N none. */
export interface Signature {
  status: "G" | "B" | "U" | "X" | "Y" | "R" | "E" | "N";
  signer: string;
  key: string;
}

export interface Submodule {
  path: string;
  hash: string;
  /** " " in sync, "-" not initialised, "+" different commit checked out, "U" conflict. */
  state: string;
}

export interface SubCommit {
  hash: string;
  short: string;
  subject: string;
}

export interface SubmoduleDiff {
  old: string | null;
  new: string | null;
  initialized: boolean;
  commits: SubCommit[];
  rewind: boolean;
  note: string | null;
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  main: boolean;
  current: boolean;
}

export interface LfsInfo {
  installed: boolean;
  used: boolean;
}

export const extras = {
  imageVersions: (root: string, group: string, path: string, from?: string, rev?: string) =>
    invoke<ImageVersions>("image_versions", { root, group, path, from, rev }),
  /** `name` is the remote-tracking name, e.g. "origin/feature". */
  deleteRemoteBranch: (root: string, name: string) => invoke<string>("delete_remote_branch", { root, name }),
  publishBranch: (root: string, remote: string) => invoke<string>("publish_branch", { root, remote }),
  setUpstream: (root: string, upstream: string) => invoke<string>("set_upstream", { root, upstream }),
  submodules: (root: string) => invoke<Submodule[]>("submodules", { root }),
  submoduleDiff: (root: string, group: string, path: string, rev?: string) =>
    invoke<SubmoduleDiff>("submodule_diff", { root, group, path, rev }),
  updateSubmodule: (root: string, path: string) => invoke<void>("update_submodule", { root, path }),
  worktrees: (root: string) => invoke<Worktree[]>("worktrees", { root }),
  addWorktree: (root: string, path: string, branch: string, create: boolean) =>
    invoke<void>("add_worktree", { root, path, branch, create }),
  removeWorktree: (root: string, path: string, force: boolean) => invoke<void>("remove_worktree", { root, path, force }),
  lfsInfo: (root: string) => invoke<LfsInfo>("lfs_info", { root }),
  lfsPull: (root: string) => invoke<string>("lfs_pull", { root }),
  /** Opens another Grove window, on the welcome screen or on `path`. */
  newWindow: (path?: string) => invoke<void>("new_window", { path: path ?? null }),
};
