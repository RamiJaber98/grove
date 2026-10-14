import type { editor } from "monaco-editor/editor/editor.api";

// The mounted diff editor, for menu commands (Find, next/previous change).
// Kept separate from DiffEditor.tsx so importing it doesn't pull Monaco into
// the startup bundle.
let active: editor.IStandaloneDiffEditor | null = null;

export const getActiveDiffEditor = () => active;
export const setActiveDiffEditor = (e: editor.IStandaloneDiffEditor | null) => {
  active = e;
};
