/** Backend calls behind the Source Control panel's file context menu. */
import { invoke } from "@tauri-apps/api/core";

export type Side = "ours" | "theirs";

export const files = {
  /** Appends patterns to the root .gitignore; returns how many were new. */
  gitignoreAdd: (root: string, patterns: string[]) => invoke<number>("gitignore_add", { root, patterns }),
  /** Resolves conflicts by taking one side's version, then stages them. */
  takeSide: (root: string, paths: string[], side: Side) => invoke<void>("take_side", { root, paths, side }),
  stashBranch: (root: string, name: string, stashRef: string) =>
    invoke<void>("stash_branch", { root, name, stashRef }),
  revealRepoFile: (root: string, path: string) => invoke<void>("reveal_repo_file", { root, path }),
  /** Returns false when VS Code wasn't found and the default app was used. */
  openInEditor: (root: string, paths: string[]) => invoke<boolean>("open_in_editor", { root, paths }),
};
