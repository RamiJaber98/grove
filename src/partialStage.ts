/**
 * Partial staging from the diff viewer: stage, unstage or discard the change
 * under the cursor ("hunk") or just the selected lines. Line numbers come
 * from Monaco's diff, which is what the user sees; the backend maps them
 * onto git's diff of the same file and applies the result with `git apply`.
 *
 * Kept free of runtime Monaco imports so runCommand can use it without
 * pulling the editor into the startup bundle.
 */
import { ask } from "@tauri-apps/plugin-dialog";
import type { editor } from "monaco-editor/editor/editor.api";
import { applyLines, type LineRanges, type PatchOp } from "./api/git";
import { withBusy } from "./actions";
import { getActiveDiffEditor, getShownTexts } from "./diffEditorHandle";
import { useRepo } from "./store/repo";

export type Scope = "hunk" | "lines";
export type DiffSide = "original" | "modified";
type Range = [number, number];

// Which side of a side-by-side diff the user last worked in, for commands
// run from outside the editor.
let lastSide: DiffSide = "modified";
export const noteFocusedSide = (side: DiffSide) => {
  lastSide = side;
};

/** The operations that make sense for the open diff. */
export function opsFor(group: string | undefined): PatchOp[] {
  if (useRepo.getState().view !== "changes") return [];
  if (group === "changes") return ["stage", "discard"];
  if (group === "staged") return ["unstage"];
  return [];
}

function span(c: editor.ILineChange, side: DiffSide): Range {
  return side === "original"
    ? [c.originalStartLineNumber, c.originalEndLineNumber]
    : [c.modifiedStartLineNumber, c.modifiedEndLineNumber];
}

/**
 * The change at `line` on `side`. A pure insertion or deletion has no lines
 * on the other side; it sits between line `start` and `start + 1`, so
 * either neighbour finds it.
 */
export function changeAt(changes: editor.ILineChange[], side: DiffSide, line: number) {
  return (
    changes.find((c) => {
      const [s, e] = span(c, side);
      return e > 0 && s <= line && line <= e;
    }) ??
    changes.find((c) => {
      const [s, e] = span(c, side);
      return e === 0 && (line === s || line === s + 1);
    }) ??
    null
  );
}

export function wholeChange(c: editor.ILineChange): LineRanges {
  return {
    old: c.originalEndLineNumber > 0 ? [[c.originalStartLineNumber, c.originalEndLineNumber]] : [],
    new: c.modifiedEndLineNumber > 0 ? [[c.modifiedStartLineNumber, c.modifiedEndLineNumber]] : [],
  };
}

/**
 * Maps selected lines onto changes. Same rule as VS Code: picking modified
 * lines of a change replaces that change's whole original block with just
 * those lines; on the original side only the picked removals are taken.
 */
function linesIn(changes: editor.ILineChange[], side: DiffSide, ranges: Range[]): LineRanges {
  const out: LineRanges = { old: [], new: [] };
  for (const c of changes) {
    for (const [s, e] of ranges) {
      if (side === "original") {
        if (c.originalEndLineNumber === 0) continue;
        const a = Math.max(s, c.originalStartLineNumber);
        const b = Math.min(e, c.originalEndLineNumber);
        if (a <= b) out.old.push([a, b]);
      } else if (c.modifiedEndLineNumber > 0) {
        const a = Math.max(s, c.modifiedStartLineNumber);
        const b = Math.min(e, c.modifiedEndLineNumber);
        if (a > b) continue;
        out.new.push([a, b]);
        if (c.originalEndLineNumber > 0) out.old.push([c.originalStartLineNumber, c.originalEndLineNumber]);
      } else {
        // A deletion after line N is picked along with line N.
        const at = Math.max(1, c.modifiedStartLineNumber);
        if (s <= at && at <= e) out.old.push([c.originalStartLineNumber, c.originalEndLineNumber]);
      }
    }
  }
  return out;
}

/** Selected line ranges; an empty selection is the cursor's line. */
function selectedRanges(ed: editor.ICodeEditor): Range[] {
  return (ed.getSelections() ?? []).map((sel) => {
    let end = sel.endLineNumber;
    // A selection ending at the start of a line doesn't include that line.
    if (end > sel.startLineNumber && sel.endColumn === 1) end--;
    return [sel.startLineNumber, end];
  });
}

const BUSY: Record<PatchOp, string> = {
  stage: "Staging…",
  unstage: "Unstaging…",
  discard: "Discarding…",
};

/** Runs `op` on the hunk at the cursor or the selected lines of `side`. */
export async function partialStage(op: PatchOp, scope: Scope, side?: DiffSide) {
  const s = useRepo.getState();
  const diff = getActiveDiffEditor();
  if (!diff || !s.selection) return s.toast("Open a file's diff first.");
  if (!opsFor(s.selection.group).includes(op)) {
    return s.toast(
      op === "unstage" ? "Open a staged file's diff to unstage lines." : "Open a changed file's diff to stage or discard lines.",
    );
  }
  // Inline mode only shows the modified editor.
  side ??= s.diffMode === "inline" ? "modified" : lastSide;
  const ed = side === "original" ? diff.getOriginalEditor() : diff.getModifiedEditor();
  const changes = diff.getLineChanges() ?? [];

  let lines: LineRanges;
  if (scope === "hunk") {
    const change = changeAt(changes, side, ed.getPosition()?.lineNumber ?? 1);
    if (!change) return s.toast("Put the cursor on a change first.");
    lines = wholeChange(change);
  } else {
    lines = linesIn(changes, side, selectedRanges(ed));
    if (!lines.old.length && !lines.new.length) return s.toast("The selection doesn't include any changes.");
  }
  return applyRanges(op, scope, lines);
}

/** Applies `op` to `lines` of the open file, confirming discards first. */
export async function applyRanges(op: PatchOp, scope: Scope, lines: LineRanges) {
  const sel = useRepo.getState().selection;
  // Taken now, before the confirmation: the lines refer to this diff.
  const shown = getShownTexts();
  if (!sel || !shown) return;
  if (op === "discard") {
    const what = scope === "hunk" ? "this change" : "the selected lines";
    const ok = await ask(`Discard ${what} in ${sel.path.split("/").pop()}?\n\nThis can't be undone.`, {
      title: "Discard Changes",
      kind: "warning",
      okLabel: "Discard",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
  }
  await withBusy(BUSY[op], (root) => applyLines(root, sel.path, sel.from, op, lines, shown));
}
