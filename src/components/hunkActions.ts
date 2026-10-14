/**
 * Partial-staging UI inside the diff editor: context-menu actions with
 * keyboard shortcuts, and a small action bar pinned to the change under the
 * mouse (or the cursor), VS Code style.
 */
import { monaco } from "../monaco";
import type { PatchOp } from "../api/git";
import { applyRanges, changeAt, opsFor, partialStage, wholeChange, noteFocusedSide, type DiffSide, type Scope } from "../partialStage";
import { useRepo } from "../store/repo";

type Editor = monaco.editor.IStandaloneCodeEditor;
type LineChange = monaco.editor.ILineChange;

const { KeyMod, KeyCode } = monaco;

interface ActionDef {
  op: PatchOp;
  scope: Scope;
  label: string;
  key: number;
  shortcut: string;
}

const isMac = navigator.userAgent.includes("Mac");
const mod = isMac ? "⌘" : "Ctrl";

// Ctrl+Alt+letter for selected lines, plus Shift for the whole change.
export const HUNK_ACTIONS: ActionDef[] = [
  { op: "stage", scope: "lines", label: "Stage Selected Lines", key: KeyCode.KeyS, shortcut: `${mod}+Alt+S` },
  { op: "stage", scope: "hunk", label: "Stage Hunk", key: KeyCode.KeyS | KeyMod.Shift, shortcut: `${mod}+Alt+Shift+S` },
  { op: "unstage", scope: "lines", label: "Unstage Selected Lines", key: KeyCode.KeyU, shortcut: `${mod}+Alt+U` },
  { op: "unstage", scope: "hunk", label: "Unstage Hunk", key: KeyCode.KeyU | KeyMod.Shift, shortcut: `${mod}+Alt+Shift+U` },
  { op: "discard", scope: "lines", label: "Discard Selected Lines", key: KeyCode.KeyD, shortcut: `${mod}+Alt+D` },
  { op: "discard", scope: "hunk", label: "Discard Hunk", key: KeyCode.KeyD | KeyMod.Shift, shortcut: `${mod}+Alt+Shift+D` },
];

const GROUP_KEY = "groveDiffGroup";

/** Wires partial staging into `diff`'s two editors. Returns a disposer. */
export function installHunkActions(diff: monaco.editor.IStandaloneDiffEditor): () => void {
  const disposers = (["original", "modified"] as DiffSide[]).map((side) =>
    installOn(diff, side === "original" ? diff.getOriginalEditor() : diff.getModifiedEditor(), side),
  );
  return () => disposers.forEach((d) => d());
}

function installOn(diff: monaco.editor.IStandaloneDiffEditor, ed: Editor, side: DiffSide): () => void {
  const subs: monaco.IDisposable[] = [];

  // The group decides which actions show (Changes: stage/discard, Staged: unstage).
  const groupKey = ed.createContextKey<string>(GROUP_KEY, "");
  const syncGroup = () => {
    const sel = useRepo.getState().selection;
    groupKey.set(opsFor(sel?.group).length ? sel!.group : "");
  };
  syncGroup();

  HUNK_ACTIONS.forEach((a, i) => {
    subs.push(
      ed.addAction({
        id: `grove.${a.op}.${a.scope}`,
        label: a.label,
        precondition: `${GROUP_KEY} == '${a.op === "unstage" ? "staged" : "changes"}'`,
        keybindings: [KeyMod.CtrlCmd | KeyMod.Alt | a.key],
        contextMenuGroupId: "0_grove_stage",
        contextMenuOrder: i,
        run: () => partialStage(a.op, a.scope, side),
      }),
    );
  });
  subs.push(ed.onDidFocusEditorText(() => noteFocusedSide(side)));

  // --- Hover action bar ---------------------------------------------------
  const bar = document.createElement("div");
  bar.className = "hunk-bar";
  bar.style.display = "none";
  const host = document.createElement("div");
  host.className = "hunk-bar-host";
  host.append(bar);
  const widget: monaco.editor.IOverlayWidget = {
    getId: () => `grove.hunkBar.${side}`,
    getDomNode: () => host,
    // Positioned by hand so it can sit at the right edge of a given line.
    // Monaco clears `top` on the node it's given, hence the host wrapper.
    getPosition: () => null,
  };
  ed.addOverlayWidget(widget);

  let shown: LineChange | null = null;
  let hideTimer = 0;

  const changes = () => diff.getLineChanges() ?? [];
  const firstLine = (c: LineChange) =>
    side === "original" ? [c.originalStartLineNumber, c.originalEndLineNumber] : [c.modifiedStartLineNumber, c.modifiedEndLineNumber];

  const place = () => {
    if (!shown) return;
    const [start, end] = firstLine(shown);
    const lineHeight = ed.getOption(monaco.editor.EditorOption.lineHeight);
    // A change with no lines on this side sits just below line `start`.
    const top = end > 0 ? ed.getTopForLineNumber(start) : start > 0 ? ed.getTopForLineNumber(start) + lineHeight : 0;
    bar.style.top = `${top - ed.getScrollTop()}px`;
    bar.style.height = `${lineHeight}px`;
  };

  const button = (label: string, title: string, danger: boolean, run: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    if (danger) b.className = "danger";
    // Keep the editor's selection: a mousedown would move the cursor.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      run();
    });
    return b;
  };

  const render = () => {
    bar.replaceChildren();
    const change = shown!;
    const ops = opsFor(useRepo.getState().selection?.group);
    const sel = ed.getSelection();
    const hasSelection = !!sel && !sel.isEmpty();
    for (const op of ops) {
      const verb = op[0].toUpperCase() + op.slice(1);
      const hunk = HUNK_ACTIONS.find((a) => a.op === op && a.scope === "hunk")!;
      const lines = HUNK_ACTIONS.find((a) => a.op === op && a.scope === "lines")!;
      bar.append(
        button(verb, `${hunk.label} (${hunk.shortcut})`, op === "discard", () =>
          applyRanges(op, "hunk", wholeChange(change)),
        ),
      );
      if (hasSelection) {
        bar.append(
          button(`${verb} Lines`, `${lines.label} (${lines.shortcut})`, op === "discard", () =>
            partialStage(op, "lines", side),
          ),
        );
      }
    }
  };

  const show = (change: LineChange | null) => {
    window.clearTimeout(hideTimer);
    if (!change || !opsFor(useRepo.getState().selection?.group).length) {
      shown = null;
      bar.style.display = "none";
      return;
    }
    shown = change;
    render();
    bar.style.display = "";
    place();
  };

  const cursorChange = () => {
    if (!ed.hasTextFocus()) return null;
    const line = ed.getPosition()?.lineNumber;
    return line ? changeAt(changes(), side, line) : null;
  };

  const hideSoon = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => show(cursorChange()), 400);
  };

  subs.push(
    ed.onMouseMove((e) => {
      const line = e.target.position?.lineNumber;
      if (e.target.type === monaco.editor.MouseTargetType.OVERLAY_WIDGET || !line) return;
      const change = changeAt(changes(), side, line);
      if (change) show(change);
      else hideSoon();
    }),
    ed.onMouseLeave(hideSoon),
    ed.onDidChangeCursorSelection(() => {
      const c = cursorChange();
      if (c) show(c);
      else if (shown) render();
    }),
    ed.onDidBlurEditorText(hideSoon),
    ed.onDidScrollChange(place),
    diff.onDidUpdateDiff(() => {
      // Changes are new objects after every diff; follow by line.
      if (!shown) return;
      const [start] = firstLine(shown);
      show(changeAt(changes(), side, Math.max(1, start)));
    }),
  );
  bar.addEventListener("mouseenter", () => window.clearTimeout(hideTimer));
  bar.addEventListener("mouseleave", hideSoon);

  const unsubscribe = useRepo.subscribe((s, prev) => {
    // Refreshes hand out a new selection object for the same file; only a
    // different file or group matters (the diff update re-finds the change).
    const moved = s.selection?.group !== prev.selection?.group || s.selection?.path !== prev.selection?.path;
    if (moved || s.view !== prev.view) {
      syncGroup();
      show(null);
    } else if (s.busy !== prev.busy) {
      bar.classList.toggle("busy", !!s.busy);
    }
  });

  return () => {
    window.clearTimeout(hideTimer);
    unsubscribe();
    subs.forEach((d) => d.dispose());
    try {
      ed.removeOverlayWidget(widget);
    } catch {
      // The editor was already disposed along with its widgets.
    }
  };
}
