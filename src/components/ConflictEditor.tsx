import { useEffect, useRef, useState } from "react";
import { monaco } from "../monaco";
import { setActiveDiffEditor } from "../diffEditorHandle";
import { useResolvedTheme } from "../theme";
import { useRepo } from "../store/repo";
import { saveResolution } from "../conflictActions";
import {
  describeSide,
  parseConflicts,
  resolvedLines,
  resolveText,
  type Choice,
  type ConflictBlock,
  type SideLabels,
} from "../conflicts";
import { ArrowDown, ArrowUp } from "./Icons";

interface Props {
  root: string;
  path: string;
  /** The working file as it is on disk (with markers). */
  text: string;
  labels: SideLabels;
}

const FONT_FAMILY = '"Cascadia Code", "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace';
const SCHEME = "grove-conflict";
const ACCEPT_COMMAND = "grove.conflict.accept";

let modelSeq = 0;

/**
 * Unsaved edits, per file, so switching to another file (or to Compare) and
 * back doesn't lose them. Only restored if the file on disk hasn't changed
 * underneath the draft.
 */
const drafts = new Map<string, { disk: string; text: string }>();

/** Which CSS role (and colour) a git side gets: "current" or "incoming". */
const role = (title: string) => (title === "Current" ? "current" : "incoming");

export default function ConflictEditor({ root, path, text, labels }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  /** Last text read from disk, and the model version that matches it. */
  const disk = useRef(text);
  const savedVersion = useRef(0);
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  const [blocks, setBlocks] = useState<ConflictBlock[]>([]);
  const [dirty, setDirty] = useState(false);
  const [diskChanged, setDiskChanged] = useState(false);
  const [saving, setSaving] = useState(false);

  const wordWrap = useRepo((s) => s.wordWrap);
  const fontSize = useRepo((s) => s.fontSize);
  const busy = useRepo((s) => s.busy);
  const theme = useResolvedTheme();
  const draftKey = `${root}\0${path}`;

  const current = () => {
    const e = editorRef.current!;
    const model = e.getModel()!;
    return { e, model, lines: model.getLinesContent(), blocks: parseConflicts(model.getLinesContent()) };
  };

  /** Replaces one block (markers included) with the chosen side(s). */
  function accept(startLine: number, choice: Choice) {
    const { e, model, lines, blocks } = current();
    const b = blocks.find((x) => x.start === startLine);
    if (!b) return;
    const keep = resolvedLines(lines, b, choice);
    const eol = model.getEOL();
    const last = model.getLineCount();
    let range: monaco.IRange;
    let textOut: string;
    if (b.end + 1 < last) {
      // Replace whole lines up to the start of the line after the block.
      range = { startLineNumber: b.start + 1, startColumn: 1, endLineNumber: b.end + 2, endColumn: 1 };
      textOut = keep.map((l) => l + eol).join("");
    } else if (keep.length || b.start === 0) {
      range = { startLineNumber: b.start + 1, startColumn: 1, endLineNumber: last, endColumn: model.getLineMaxColumn(last) };
      textOut = keep.join(eol);
    } else {
      // Block is at the very end with nothing kept: also drop the line break before it.
      range = { startLineNumber: b.start, startColumn: model.getLineMaxColumn(b.start), endLineNumber: last, endColumn: model.getLineMaxColumn(last) };
      textOut = "";
    }
    e.pushUndoStop();
    e.executeEdits("grove-conflict", [{ range, text: textOut, forceMoveMarkers: true }]);
    e.pushUndoStop();
    e.setPosition({ lineNumber: Math.min(b.start + 1, model.getLineCount()), column: 1 });
    e.focus();
  }

  function acceptAll(choice: Choice) {
    const { e, model } = current();
    const next = resolveText(model.getValue(), choice);
    if (next === model.getValue()) return;
    e.pushUndoStop();
    e.executeEdits("grove-conflict", [{ range: model.getFullModelRange(), text: next }]);
    e.pushUndoStop();
    e.focus();
  }

  /** Moves the cursor to the next/previous block, wrapping around. */
  function navigate(dir: 1 | -1) {
    const { e, blocks } = current();
    if (!blocks.length) return;
    const line = (e.getPosition()?.lineNumber ?? 1) - 1;
    const target =
      dir === 1
        ? blocks.find((b) => b.start > line) ?? blocks[0]
        : [...blocks].reverse().find((b) => b.end < line) ?? blocks[blocks.length - 1];
    e.setPosition({ lineNumber: target.start + 1, column: 1 });
    e.revealLinesInCenterIfOutsideViewport(target.start + 1, target.end + 1);
    e.focus();
  }

  async function save(stage: boolean) {
    const { model } = current();
    const value = model.getValue();
    const version = model.getAlternativeVersionId();
    setSaving(true);
    try {
      if (await saveResolution(path, value, stage)) {
        disk.current = value;
        savedVersion.current = version;
        drafts.delete(draftKey);
        setDirty(model.getAlternativeVersionId() !== version);
        setDiskChanged(false);
      }
    } finally {
      setSaving(false);
    }
  }
  const saveRef = useRef(save);
  saveRef.current = save;
  /** Re-parses the model: block list, dirty flag and highlights. */
  const refreshRef = useRef(() => {});
  const actionsRef = useRef({ accept, navigate });
  actionsRef.current = { accept, navigate };

  // Create once per file (the parent keys this component by path).
  useEffect(() => {
    const draft = drafts.get(draftKey);
    const restore = draft && draft.disk === text;
    const uri = monaco.Uri.from({ scheme: SCHEME, path: `/${path}`, query: String(++modelSeq) });
    const model = monaco.editor.createModel(restore ? draft.text : text, undefined, uri);
    const e = monaco.editor.create(host.current!, {
      model,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: true },
      fontFamily: FONT_FAMILY,
      codeLens: true,
      renderLineHighlight: "line",
      overviewRulerLanes: 2,
    });
    editorRef.current = e;
    savedVersion.current = restore ? -1 : model.getAlternativeVersionId();

    const decorations = e.createDecorationsCollection();
    const refresh = () => {
      const lines = model.getLinesContent();
      const found = parseConflicts(lines);
      setBlocks(found);
      setDirty(model.getAlternativeVersionId() !== savedVersion.current);
      decorations.set(found.flatMap((b) => blockDecorations(b, labelsRef.current)));
    };
    refreshRef.current = refresh;
    refresh();
    const changeSub = model.onDidChangeContent(refresh);

    // F7 / Shift+F7 and Ctrl+F go through the active diff editor; stand in
    // for one so they work here too.
    setActiveDiffEditor({
      goToDiff: (target: "next" | "previous") => actionsRef.current.navigate(target === "next" ? 1 : -1),
      getModifiedEditor: () => e,
    } as unknown as monaco.editor.IStandaloneDiffEditor);

    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current(false));

    // Per-block "Accept …" links above each <<<<<<< line.
    const command = monaco.editor.registerCommand(ACCEPT_COMMAND, (_accessor, start: number, choice: Choice) =>
      actionsRef.current.accept(start, choice),
    );
    const lensProvider = monaco.languages.registerCodeLensProvider(
      { scheme: SCHEME },
      {
        provideCodeLenses(m) {
          if (m !== model) return { lenses: [], dispose() {} };
          const l = labelsRef.current;
          const lenses = parseConflicts(m.getLinesContent()).flatMap((b) => {
            const range = { startLineNumber: b.start + 1, startColumn: 1, endLineNumber: b.start + 1, endColumn: 1 };
            const lens = (title: string, choice: Choice, tooltip: string) => ({
              range,
              command: { id: ACCEPT_COMMAND, title, tooltip, arguments: [b.start, choice] },
            });
            const items = [
              lens(`Accept ${l.ours.title}`, "ours", `Keep ${describeSide(l.ours, 80)}`),
              lens(`Accept ${l.theirs.title}`, "theirs", `Keep ${describeSide(l.theirs, 80)}`),
              lens("Accept Both", "both", "Keep both, top then bottom"),
            ];
            if (b.base !== null) items.push(lens("Accept Base", "base", "Keep the common ancestor's version"));
            return items;
          });
          return { lenses, dispose() {} };
        },
      },
    );

    return () => {
      if (model.getAlternativeVersionId() !== savedVersion.current) {
        drafts.set(draftKey, { disk: disk.current, text: model.getValue() });
      } else {
        drafts.delete(draftKey);
      }
      lensProvider.dispose();
      command.dispose();
      changeSub.dispose();
      setActiveDiffEditor(null);
      e.dispose();
      model.dispose();
      editorRef.current = null;
    };
  }, []);

  // The file changed on disk (refresh after a save here, or an edit made in
  // another editor). Take the new text unless the user has unsaved edits.
  useEffect(() => {
    if (text === disk.current) return;
    const { e, model } = current();
    if (model.getAlternativeVersionId() === savedVersion.current) {
      const view = e.saveViewState();
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      savedVersion.current = model.getAlternativeVersionId();
      disk.current = text;
      if (view) e.restoreViewState(view);
      setDirty(false);
      setDiskChanged(false);
    } else {
      setDiskChanged(true);
    }
  }, [text]);

  function reloadFromDisk() {
    const { model } = current();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    savedVersion.current = model.getAlternativeVersionId();
    disk.current = text;
    drafts.delete(draftKey);
    setDirty(false);
    setDiskChanged(false);
  }

  // Labels can change on a reload (e.g. the operation finished); redraw.
  useEffect(() => refreshRef.current(), [labels]);

  useEffect(() => {
    editorRef.current!.updateOptions({
      wordWrap: wordWrap ? "on" : "off",
      fontSize,
      lineHeight: Math.round(fontSize * 1.55),
    });
  }, [wordWrap, fontSize]);

  useEffect(() => {
    monaco.editor.setTheme(theme === "dark" ? "grove-dark" : "grove-light");
  }, [theme]);

  const remaining = blocks.length;
  const disabled = saving || !!busy;
  const ours = labels.ours;
  const theirs = labels.theirs;
  // List Current first, whichever git side that is.
  const sides: [Choice, typeof ours][] = role(ours.title) === "current" ? [["ours", ours], ["theirs", theirs]] : [["theirs", theirs], ["ours", ours]];

  return (
    <div className="conflict-editor">
      <div className="conflict-toolbar">
        <div className="diff-nav">
          <button className="icon-btn" title="Previous conflict (Shift+F7)" onClick={() => navigate(-1)} disabled={!remaining}>
            <ArrowUp size={14} />
          </button>
          <button className="icon-btn" title="Next conflict (F7)" onClick={() => navigate(1)} disabled={!remaining}>
            <ArrowDown size={14} />
          </button>
        </div>
        <span className={`conflict-count ${remaining ? "" : "done"}`}>
          {remaining ? `${remaining} conflict${remaining === 1 ? "" : "s"} remaining` : "No conflicts remaining"}
        </span>
        <span className="conflict-legend">
          {sides.map(([choice, s]) => (
            <span key={choice} className={`legend-${role(s.title)}`} title={s.detail ?? undefined}>
              {describeSide(s)}
            </span>
          ))}
        </span>
        <span className="conflict-spacer" />
        {sides.map(([choice, s]) => (
          <button key={choice} className="btn small" disabled={!remaining} onClick={() => acceptAll(choice)} title={`Resolve every conflict with ${describeSide(s, 80)}`}>
            Accept All {s.title}
          </button>
        ))}
        <button className="btn small" disabled={disabled || !dirty} onClick={() => save(false)} title="Write the file (Ctrl+S)">
          Save{dirty ? " •" : ""}
        </button>
        <button className="btn small primary" disabled={disabled} onClick={() => save(true)} title="Write the file and stage it">
          Save &amp; Mark Resolved
        </button>
      </div>
      {diskChanged && (
        <div className="diff-notice conflict-notice">
          The file changed on disk while you had unsaved edits.{" "}
          <button className="link-btn" onClick={reloadFromDisk}>Discard my edits and reload</button>
        </div>
      )}
      <div className="monaco-host" ref={host} />
    </div>
  );
}

/** Whole-line highlights for one block, coloured by whose side it is. */
function blockDecorations(b: ConflictBlock, labels: SideLabels): monaco.editor.IModelDeltaDecoration[] {
  const oursRole = role(labels.ours.title);
  const theirsRole = role(labels.theirs.title);
  const line = (n: number, className: string, after?: string): monaco.editor.IModelDeltaDecoration => ({
    range: { startLineNumber: n + 1, startColumn: 1, endLineNumber: n + 1, endColumn: 1 },
    options: {
      isWholeLine: true,
      className,
      ...(after ? { after: { content: `  ${after}`, inlineClassName: "conflict-marker-hint" } } : {}),
    },
  });
  const span = (from: number, to: number, className: string, color: string): monaco.editor.IModelDeltaDecoration[] =>
    to < from
      ? []
      : [
          {
            range: { startLineNumber: from + 1, startColumn: 1, endLineNumber: to + 1, endColumn: 1 },
            options: {
              isWholeLine: true,
              className,
              overviewRuler: { color, position: monaco.editor.OverviewRulerLane.Full },
            },
          },
        ];
  const colors = { current: "#3fa463aa", incoming: "#4f8ff0aa", base: "#888888aa" };
  const oursEnd = (b.base ?? b.separator) - 1;
  return [
    line(b.start, `conflict-${oursRole}-header`, `(${describeSide(labels.ours, 60)})`),
    ...span(b.start + 1, oursEnd, `conflict-${oursRole}`, colors[oursRole]),
    ...(b.base !== null
      ? [line(b.base, "conflict-base-header", "(Common ancestor)"), ...span(b.base + 1, b.separator - 1, "conflict-base", colors.base)]
      : []),
    line(b.separator, "conflict-separator"),
    ...span(b.separator + 1, b.end - 1, `conflict-${theirsRole}`, colors[theirsRole]),
    line(b.end, `conflict-${theirsRole}-header`, `(${describeSide(labels.theirs, 60)})`),
  ];
}
