/** Backend calls for interactive rebase (src-tauri/src/git/rebase.rs). */
import { invoke } from "@tauri-apps/api/core";

export type RebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

export interface PlanCommit {
  hash: string;
  short: string;
  subject: string;
  /** Full message, subject included. */
  message: string;
  author: string;
  time: number;
  /** Already on a remote-tracking branch; rewriting it needs a force push. */
  pushed: boolean;
}

export interface RebasePlan {
  base: string;
  baseShort: string;
  /** Base isn't an ancestor of HEAD, so the commits move onto it too. */
  moves: boolean;
  /** Oldest first, like git's todo list. */
  commits: PlanCommit[];
}

export interface RebaseStep {
  hash: string;
  action: RebaseAction;
  /** New message for a reword, or the combined message on a squash group's first commit. */
  message: string | null;
}

export interface RebaseOutcome {
  state: "done" | "edit" | "conflict" | "stopped";
  message: string;
}

export const rebaseApi = {
  plan: (root: string, base: string) => invoke<RebasePlan>("rebase_plan", { root, base }),
  start: (root: string, base: string, steps: RebaseStep[], autostash: boolean) =>
    invoke<RebaseOutcome>("start_interactive_rebase", { root, base, steps, autostash }),
};
