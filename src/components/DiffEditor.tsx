import { useEffect, useRef } from "react";
import { monaco } from "../monaco";
import { setActiveDiffEditor } from "../diffEditorHandle";
import { useResolvedTheme } from "../theme";
import { useRepo } from "../store/repo";
import { installHunkActions } from "./hunkActions";

export interface DiffStats {
  added: number;
  removed: number;
  hunks: number;
}

interface Props {
  path: string;
  original: string;
  modified: string;
  onStats: (stats: DiffStats) => void;
  /** Offer stage/unstage/discard of hunks and lines (working-tree diffs only). */
  partialStaging?: boolean;
}

let modelSeq = 0;

const FONT_FAMILY = '"Cascadia Code", "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace';

export default function DiffEditor({ path, original, modified, onStats, partialStaging }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const shownPath = useRef<string | null>(null);
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;

  const diffMode = useRepo((s) => s.diffMode);
  const ignoreWhitespace = useRepo((s) => s.ignoreWhitespace);
  const wordWrap = useRepo((s) => s.wordWrap);
  const fontSize = useRepo((s) => s.fontSize);
  const theme = useResolvedTheme();

  // Create once; dispose with the component.
  useEffect(() => {
    const e = monaco.editor.createDiffEditor(host.current!, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      // The toolbar toggle decides the layout, never the window width.
      useInlineViewWhenSpaceIsLimited: false,
      renderMarginRevertIcon: false,
      renderOverviewRuler: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: true },
      fontFamily: FONT_FAMILY,
      maxComputationTime: 5000,
      domReadOnly: true,
    });
    editor.current = e;
    setActiveDiffEditor(e);

    const sub = e.onDidUpdateDiff(() => {
      const changes = e.getLineChanges() ?? [];
      let added = 0;
      let removed = 0;
      for (const c of changes) {
        if (c.modifiedEndLineNumber > 0) added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
        if (c.originalEndLineNumber > 0) removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
      }
      onStatsRef.current({ added, removed, hunks: changes.length });
    });

    return () => {
      sub.dispose();
      const model = e.getModel();
      e.dispose();
      model?.original.dispose();
      model?.modified.dispose();
      setActiveDiffEditor(null);
      editor.current = null;
    };
  }, []);

  // Partial staging (hunks and lines).
  useEffect(() => (partialStaging ? installHunkActions(editor.current!) : undefined), [partialStaging]);

  // Swap in new content, keeping scroll position when it's the same file
  // being refreshed (e.g. saved in another editor).
  useEffect(() => {
    const e = editor.current!;
    const old = e.getModel();
    const samePath = shownPath.current === path;
    if (samePath && old && old.original.getValue() === original && old.modified.getValue() === modified) return;

    const viewState = samePath ? e.saveViewState() : null;
    const seq = ++modelSeq;
    // The URI's file name picks the syntax-highlighting language.
    const uri = (side: string) => monaco.Uri.from({ scheme: `grove-${side}`, path: `/${path}`, query: String(seq) });
    e.setModel({
      original: monaco.editor.createModel(original, undefined, uri("original")),
      modified: monaco.editor.createModel(modified, undefined, uri("modified")),
    });
    old?.original.dispose();
    old?.modified.dispose();

    if (viewState) e.restoreViewState(viewState);
    else e.getModifiedEditor().setScrollTop(0);
    shownPath.current = path;
  }, [path, original, modified]);

  useEffect(() => {
    editor.current!.updateOptions({
      renderSideBySide: diffMode === "side-by-side",
      ignoreTrimWhitespace: ignoreWhitespace,
      wordWrap: wordWrap ? "on" : "off",
      diffWordWrap: wordWrap ? "on" : "off",
      fontSize,
      lineHeight: Math.round(fontSize * 1.55),
    });
  }, [diffMode, ignoreWhitespace, wordWrap, fontSize]);

  useEffect(() => {
    monaco.editor.setTheme(theme === "dark" ? "grove-dark" : "grove-light");
  }, [theme]);

  return <div className="monaco-host" ref={host} />;
}
