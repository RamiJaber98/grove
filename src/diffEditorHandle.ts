import type { editor } from "monaco-editor/editor/editor.api";

// The mounted diff editor, for menu commands (Find, next/previous change).
// Kept separate from DiffEditor.tsx so importing it doesn't pull Monaco into
// the startup bundle.
let active: editor.IStandaloneDiffEditor | null = null;

export const getActiveDiffEditor = () => active;
export const setActiveDiffEditor = (e: editor.IStandaloneDiffEditor | null) => {
  active = e;
  shown = null;
};

// The exact texts the active editor was given. Partial staging sends them
// along so the backend can refuse line numbers from an outdated diff.
let shown: { original: string; modified: string } | null = null;

export const getShownTexts = () => shown;
export const setShownTexts = (texts: { original: string; modified: string } | null) => {
  shown = texts;
};
