/**
 * The open comparison shown in the Compare tab. Kept out of the main repo
 * store: it's only set by explicit "Compare…" actions and cleared on close.
 */
import { create } from "zustand";
import { loadPref, savePref } from "./prefs";
import { useRepo } from "./repo";

export interface CompareTarget {
  /** Any ref git can resolve: branch, tag or commit hash. */
  a: string;
  /** Null compares with the working tree. */
  b: string | null;
  /** Display names, when the refs are raw hashes. */
  aLabel?: string;
  bLabel?: string;
  /** Diff from the merge base (A...B) rather than tip to tip (A..B). */
  threeDot: boolean;
}

export const useCompare = create<{ target: CompareTarget | null }>(() => ({ target: null }));

export function openCompare(t: Omit<CompareTarget, "threeDot"> & { threeDot?: boolean }) {
  useCompare.setState({ target: { ...t, threeDot: t.threeDot ?? loadPref("compareThreeDot", false) } });
  useRepo.getState().setView("compare");
}

export function updateCompare(patch: Partial<CompareTarget>) {
  const target = useCompare.getState().target;
  if (!target) return;
  if (patch.threeDot !== undefined) savePref("compareThreeDot", patch.threeDot);
  useCompare.setState({ target: { ...target, ...patch } });
}

export function closeCompare() {
  useCompare.setState({ target: null });
  const s = useRepo.getState();
  if (s.view === "compare") s.setView("history");
}

// A different repository has different refs.
useRepo.subscribe((s, prev) => {
  if (s.repo?.root !== prev.repo?.root && useCompare.getState().target) {
    useCompare.setState({ target: null });
    if (s.view === "compare") s.setView("changes");
  }
});
