/**
 * Multi-selection in the Source Control panel. Separate from the store's
 * `selection`, which is the one file the diff shows (the last one clicked):
 * this is the set that hover actions, keys and the context menu act on.
 *
 * A selection lives in a single list (one group, or one stash), since every
 * action is specific to the group its files are in.
 */
import { create } from "zustand";
import type { FileChange } from "./api/git";
import { useRepo, type Group, type Selection } from "./store/repo";

/** Identifies one file list: a group, or a single stash's files. */
export const listKey = (group: Group, stashRef?: string) => (group === "stash" ? `stash:${stashRef}` : group);

interface PanelSelection {
  key: string | null;
  paths: string[];
  /** Where a Shift+click / Shift+Arrow range starts. */
  anchor: string | null;
  /** Expanded state of each section, by list key (or "stashed"). */
  open: Record<string, boolean>;
}

export const usePanelSelection = create<PanelSelection>(() => ({ key: null, paths: [], anchor: null, open: {} }));

export function filesOf(key: string | null): FileChange[] {
  const s = useRepo.getState();
  if (key === "staged") return s.staged;
  if (key === "changes") return s.changes;
  if (key === "conflicts") return s.conflicts;
  if (key?.startsWith("stash:")) return s.stashes.find((st) => `stash:${st.ref}` === key)?.files ?? [];
  return [];
}

const set = (key: string, paths: string[], anchor: string | null) =>
  usePanelSelection.setState({ key, paths, anchor });

export function selectOnly(key: string, path: string) {
  set(key, [path], path);
}

/** Ctrl/Cmd+click. Toggling in another list starts over there. */
export function toggle(key: string, path: string) {
  const s = usePanelSelection.getState();
  if (s.key !== key) return selectOnly(key, path);
  const paths = s.paths.includes(path) ? s.paths.filter((p) => p !== path) : [...s.paths, path];
  set(key, paths, path);
}

/** Shift+click / Shift+Arrow: everything between the anchor and `path`. */
export function selectRange(key: string, path: string) {
  const s = usePanelSelection.getState();
  const files = filesOf(key).map((f) => f.path);
  const anchor = s.key === key && s.anchor && files.includes(s.anchor) ? s.anchor : path;
  const [a, b] = [files.indexOf(anchor), files.indexOf(path)].sort((x, y) => x - y);
  set(key, files.slice(a, b + 1), anchor);
}

export function selectAll(key: string, focused: string) {
  set(key, filesOf(key).map((f) => f.path), focused);
}

export const isSelected = (key: string, path: string) => {
  const s = usePanelSelection.getState();
  return s.key === key && s.paths.includes(path);
};

/**
 * What an action on `file` applies to: the whole selection when `file` is
 * part of it, otherwise just `file`. Returned in list order.
 */
export function targetsFor(key: string, file: FileChange): FileChange[] {
  if (!isSelected(key, file.path)) return [file];
  const { paths } = usePanelSelection.getState();
  return filesOf(key).filter((f) => paths.includes(f.path));
}

export function isOpen(id: string, nested: boolean) {
  return usePanelSelection.getState().open[id] ?? !nested;
}

export function setOpen(id: string, open: boolean) {
  usePanelSelection.setState((s) => ({ open: { ...s.open, [id]: open } }));
}

const keyOf = (sel: Selection) => listKey(sel.group, sel.stashRef);

/**
 * Keeps the selection valid across refreshes: drops files that are gone,
 * and when the diff's file just moved groups (it was staged or unstaged),
 * brings the other selected files that moved with it along too.
 */
useRepo.subscribe((state, prev) => {
  if (state.statusVersion === prev.statusVersion && state.selection === prev.selection && state.repo === prev.repo) return;
  const ps = usePanelSelection.getState();
  if (state.repo !== prev.repo) return usePanelSelection.setState({ key: null, paths: [], anchor: null, open: {} });
  if (!ps.key) return;

  const before = prev.selection;
  const after = state.selection;
  if (before && after && before.path === after.path && keyOf(before) === ps.key && keyOf(after) !== ps.key) {
    const key = keyOf(after);
    const moved = filesOf(key).filter((f) => ps.paths.includes(f.path)).map((f) => f.path);
    return set(key, moved.length ? moved : [after.path], after.path);
  }

  const present = new Set(filesOf(ps.key).map((f) => f.path));
  const paths = ps.paths.filter((p) => present.has(p));
  if (paths.length !== ps.paths.length) {
    set(ps.key, paths, ps.anchor && present.has(ps.anchor) ? ps.anchor : (paths[0] ?? null));
  }
});
