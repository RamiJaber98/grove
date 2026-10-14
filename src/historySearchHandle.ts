// The History view's search box, for the context-aware Ctrl/Cmd+F command.
// Kept separate (like diffEditorHandle.ts) so runCommand needn't import the view.
let focus: (() => void) | null = null;

export const setHistorySearchFocus = (fn: (() => void) | null) => {
  focus = fn;
};

/** Focuses the search box if the History view is mounted; false otherwise. */
export function focusHistorySearch(): boolean {
  if (!focus) return false;
  focus();
  return true;
}
