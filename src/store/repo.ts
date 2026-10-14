import { create } from "zustand";
import { ask } from "@tauri-apps/plugin-dialog";
import { errorMessage, git, type FileChange, type RepoInfo, type StashEntry } from "../api/git";
import { loadPref, savePref } from "./prefs";

export type DiffMode = "side-by-side" | "inline";
export type Theme = "system" | "light" | "dark";
export type Group = "conflicts" | "staged" | "changes" | "stash";

export interface Selection {
  group: Group;
  path: string;
  /** Set when the file belongs to a stash entry. */
  stashRef?: string;
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

const MAX_RECENT = 10;

interface State {
  repo: RepoInfo | null;
  loading: boolean;

  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasCommits: boolean;
  staged: FileChange[];
  changes: FileChange[];
  conflicts: FileChange[];
  stashes: StashEntry[];

  selection: Selection | null;
  commitMessage: string;

  diffMode: DiffMode;
  ignoreWhitespace: boolean;
  wordWrap: boolean;
  theme: Theme;
  panelWidth: number;
  recent: string[];
  toasts: Toast[];

  openRepo: (path: string) => Promise<void>;
  closeRepo: () => void;
  refresh: () => Promise<void>;
  stage: (files: FileChange[]) => Promise<void>;
  unstage: (files: FileChange[]) => Promise<void>;
  unstageAll: () => Promise<void>;
  discard: (files: FileChange[]) => Promise<void>;
  select: (s: Selection | null) => void;
  setCommitMessage: (m: string) => void;
  setDiffMode: (m: DiffMode) => void;
  toggleWhitespace: () => void;
  toggleWordWrap: () => void;
  setTheme: (t: Theme) => void;
  setPanelWidth: (w: number) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
}

const EMPTY_STATUS = {
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  hasCommits: true,
  staged: [],
  changes: [],
  conflicts: [],
  stashes: [],
};

let toastSeq = 0;

// Refreshes are coalesced: a request while one is running schedules exactly
// one more run afterwards instead of piling up.
let inflight: Promise<void> | null = null;
let rerun = false;

const fileName = (path: string) => path.split("/").pop() ?? path;

export const useRepo = create<State>((set, get) => {
  async function loadStatus() {
    const repo = get().repo;
    if (!repo) return;
    const status = await git.status(repo.root);
    // Ignore results for a repo that was closed or switched meanwhile.
    if (get().repo?.root !== repo.root) return;

    const { selection } = get();
    const lists: Record<Group, FileChange[]> = {
      conflicts: status.conflicts,
      staged: status.staged,
      changes: status.changes,
      stash: [],
    };
    const stillThere =
      selection && (selection.group === "stash" || lists[selection.group].some((f) => f.path === selection.path));
    set({ ...status, selection: stillThere ? selection : null });
  }

  /** Runs a git mutation, reports failure, and always refreshes afterwards. */
  async function mutate(fn: (root: string) => Promise<void>) {
    const repo = get().repo;
    if (!repo) return;
    try {
      await fn(repo.root);
    } catch (e) {
      get().toast(errorMessage(e), "error");
    }
    await get().refresh();
  }

  return {
    repo: null,
    loading: false,
    ...EMPTY_STATUS,
    selection: null,
    commitMessage: "",

    diffMode: loadPref<DiffMode>("diffMode", "side-by-side"),
    ignoreWhitespace: loadPref("ignoreWhitespace", false),
    wordWrap: loadPref("wordWrap", false),
    theme: loadPref<Theme>("theme", "system"),
    panelWidth: loadPref("panelWidth", 340),
    recent: loadPref<string[]>("recent", []),
    toasts: [],

    async openRepo(path) {
      set({ loading: true });
      try {
        const repo = await git.openRepo(path);
        const recent = [repo.root, ...get().recent.filter((r) => r !== repo.root)].slice(0, MAX_RECENT);
        savePref("recent", recent);
        set({ repo, recent, ...EMPTY_STATUS, selection: null, commitMessage: "" });
        await get().refresh();
      } catch (e) {
        get().toast(errorMessage(e), "error");
      } finally {
        set({ loading: false });
      }
    },

    closeRepo() {
      git.closeRepo().catch(() => {});
      set({ repo: null, ...EMPTY_STATUS, selection: null });
    },

    refresh() {
      if (inflight) {
        rerun = true;
        return inflight;
      }
      inflight = (async () => {
        do {
          rerun = false;
          try {
            await loadStatus();
          } catch (e) {
            get().toast(errorMessage(e), "error");
          }
        } while (rerun);
      })().finally(() => {
        inflight = null;
      });
      return inflight;
    },

    stage: (files) => mutate((root) => git.stage(root, files.map((f) => f.path))),
    unstage: (files) =>
      // Unstaging a rename must also restore the old path in the index.
      mutate((root) => git.unstage(root, files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])))),
    unstageAll: () => mutate((root) => git.unstageAll(root)),

    async discard(files) {
      if (files.length === 0) return;
      const untracked = files.filter((f) => f.kind === "U").map((f) => f.path);
      const tracked = files.filter((f) => f.kind !== "U").map((f) => f.path);

      let message: string;
      if (files.length === 1) {
        message = untracked.length
          ? `Delete the untracked file "${fileName(files[0].path)}"?`
          : `Discard your changes to "${fileName(files[0].path)}"?`;
      } else {
        message = `Discard changes to ${files.length} files?`;
        if (untracked.length) message += ` ${untracked.length} untracked file(s) will be deleted.`;
      }
      const ok = await ask(`${message}\n\nThis can't be undone.`, {
        title: "Discard Changes",
        kind: "warning",
        okLabel: untracked.length === files.length ? "Delete" : "Discard",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
      await mutate((root) => git.discard(root, tracked, untracked));
    },

    select: (selection) => set({ selection }),
    setCommitMessage: (commitMessage) => set({ commitMessage }),

    setDiffMode(diffMode) {
      savePref("diffMode", diffMode);
      set({ diffMode });
    },
    toggleWhitespace() {
      const ignoreWhitespace = !get().ignoreWhitespace;
      savePref("ignoreWhitespace", ignoreWhitespace);
      set({ ignoreWhitespace });
    },
    toggleWordWrap() {
      const wordWrap = !get().wordWrap;
      savePref("wordWrap", wordWrap);
      set({ wordWrap });
    },
    setTheme(theme) {
      savePref("theme", theme);
      set({ theme });
    },
    setPanelWidth(panelWidth) {
      savePref("panelWidth", panelWidth);
      set({ panelWidth });
    },

    toast(text, kind = "info") {
      const id = ++toastSeq;
      set({ toasts: [...get().toasts, { id, text, kind }] });
      setTimeout(() => get().dismissToast(id), kind === "error" ? 8000 : 3500);
    },
    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
  };
});
