/**
 * Monaco, bundled locally and trimmed for read-only diffs: the core editor,
 * the diff widget, a handful of navigation features, and syntax highlighting
 * for every language. Language services (TypeScript, JSON, CSS, HTML workers)
 * are deliberately left out — they would flag unresolved imports as errors
 * in the diff and add megabytes to the app.
 */
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

// Editor features, via Monaco's per-feature registry (each pulls in its own CSS).
import "monaco-editor/features/codicon/register";
import "monaco-editor/features/diffEditor/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/contextmenu/register";
import "monaco-editor/features/bracketMatching/register";
import "monaco-editor/features/wordHighlighter/register";
import "monaco-editor/features/wordOperations/register";
import "monaco-editor/features/lineSelection/register";
import "monaco-editor/features/readOnlyMessage/register";
import "monaco-editor/features/stickyScroll/register";
import "monaco-editor/features/gotoLine/register";
// Merge conflict editor: Accept links above each block, and editing comforts.
import "monaco-editor/features/codelens/register";
import "monaco-editor/features/linesOperations/register";
import "monaco-editor/features/multicursor/register";
// Syntax highlighting only (Monarch grammars, loaded lazily per language).
import "monaco-editor/languages/definitions/register.all";

// The only worker needed: it computes the diff off the UI thread.
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

monaco.editor.defineTheme("grove-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1e1f22",
    "editorGutter.background": "#1e1f22",
    "diffEditor.insertedTextBackground": "#3fa46333",
    "diffEditor.removedTextBackground": "#ef6b6b33",
    "diffEditor.insertedLineBackground": "#3fa4631c",
    "diffEditor.removedLineBackground": "#ef6b6b1c",
  },
});
monaco.editor.defineTheme("grove-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "diffEditor.insertedTextBackground": "#2f8a4c30",
    "diffEditor.removedTextBackground": "#cf3a3a2c",
    "diffEditor.insertedLineBackground": "#2f8a4c14",
    "diffEditor.removedLineBackground": "#cf3a3a12",
  },
});

export { monaco };
