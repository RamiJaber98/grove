import { create } from "zustand";
import { errorMessage, git, type FileChange, type RepoInfo, type StashEntry } from "../api/git";
import { loadPref, savePref } from "./prefs";

export type DiffMode = "side-by-side" | "inline";
export type Theme = "system" | "light" | "dark";
export type Group = "staged" | "changes" | "stash";

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
  staged: FileChange[];
  changes: FileChange[];
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

let toastSeq = 0;

export const useRepo = create<State>((set, get) => ({
  repo: null,
  loading: false,
  staged: [],
  changes: [],
  stashes: [],
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
      set({ repo, recent, selection: null, commitMessage: "" });
    } catch (e) {
      get().toast(errorMessage(e), "error");
    } finally {
      set({ loading: false });
    }
  },

  closeRepo() {
    set({ repo: null, staged: [], changes: [], stashes: [], selection: null });
  },

  async refresh() {
    const { repo } = get();
    if (!repo) return;
    try {
      // Phase 2 adds status and stash loading here.
      set({ repo: await git.openRepo(repo.root) });
    } catch (e) {
      get().toast(errorMessage(e), "error");
    }
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
}));
