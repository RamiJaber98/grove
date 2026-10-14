/**
 * State for the File History / Blame tab. Kept apart from the main repo
 * store: it only matters while that tab is open.
 */
import { create } from "zustand";
import { useRepo } from "./repo";

export type FileMode = "history" | "blame";

interface FileViewState {
  /** The file as it's named today; history follows renames back from here. */
  path: string | null;
  mode: FileMode;
  /** Commit selected in the history list. */
  selected: string | null;
  /** Blamed revision: null is the working tree, else "HEAD" or a commit hash. */
  blameRev: string | null;
  /** The file's name at `blameRev`, when an older commit knew it by another name. */
  blamePath: string | null;
  setMode: (mode: FileMode) => void;
  select: (hash: string | null) => void;
}

export const useFileView = create<FileViewState>((set) => ({
  path: null,
  mode: "history",
  selected: null,
  blameRev: null,
  blamePath: null,
  setMode: (mode) => set({ mode }),
  select: (selected) => set({ selected }),
}));

/** Shows the commits that touched `path`, optionally with one selected. */
export function openFileHistory(path: string, select: string | null = null) {
  const s = useFileView.getState();
  useFileView.setState({
    path,
    mode: "history",
    selected: select ?? (s.path === path ? s.selected : null),
    ...(s.path === path ? {} : { blameRev: null, blamePath: null }),
  });
  useRepo.getState().setView("file");
}

/** Blames `path` at `rev` (null = working tree). `atPath` is its name at that revision. */
export function openBlame(path: string, rev: string | null = null, atPath: string | null = null) {
  const s = useFileView.getState();
  useFileView.setState({
    path,
    mode: "blame",
    blameRev: rev,
    blamePath: atPath,
    selected: s.path === path ? s.selected : null,
  });
  useRepo.getState().setView("file");
}

// A different (or closed) repository invalidates the open file.
useRepo.subscribe((s, prev) => {
  if (s.repo?.root === prev.repo?.root) return;
  useFileView.setState({ path: null, selected: null, blameRev: null, blamePath: null });
  if (s.view === "file") s.setView("changes");
});

// Other parts of the UI (e.g. file context menus) open these views by event,
// with the repo-relative path as the detail. preventDefault() tells the
// sender the event was handled.
function onPathEvent(open: (path: string) => void) {
  return (e: Event) => {
    const path = (e as CustomEvent<unknown>).detail;
    if (typeof path === "string" && path && useRepo.getState().repo) {
      e.preventDefault();
      open(path);
    }
  };
}
window.addEventListener("grove:file-history", onPathEvent((p) => openFileHistory(p)));
window.addEventListener("grove:blame", onPathEvent((p) => openBlame(p)));
