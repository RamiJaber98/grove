/**
 * Keyboard shortcuts, handled in the page. On Windows, native menu
 * accelerators don't fire while the web view has keyboard focus, so the
 * shortcuts shown in the menus are implemented here too. Where both fire
 * (macOS), runCommand's de-duplication keeps a command from running twice.
 */
import { runCommand } from "./runCommand";

type Binding = { key: string; mod?: boolean; shift?: boolean; alt?: boolean; id: string };

// `key` matches KeyboardEvent.code, which ignores keyboard layout and Shift.
const BINDINGS: Binding[] = [
  { key: "KeyO", mod: true, id: "open_repo" },
  { key: "KeyW", mod: true, id: "close_repo" },
  { key: "Comma", mod: true, id: "settings" },
  { key: "Slash", mod: true, id: "shortcuts" },
  { key: "F5", id: "refresh" },
  { key: "KeyH", mod: true, shift: true, id: "show_history" },
  { key: "KeyB", mod: true, shift: true, id: "checkout_branch" },
  { key: "KeyN", mod: true, shift: true, id: "new_branch" },
  { key: "KeyF", mod: true, id: "find" },
  { key: "F7", id: "next_change" },
  { key: "F7", shift: true, id: "prev_change" },
  { key: "KeyZ", alt: true, id: "toggle_word_wrap" },
];

const isMac = navigator.userAgent.includes("Mac");

/** The `key` value a binding's `code` produces, for events that carry no
 * `code` (some remote-desktop and accessibility tools send those). */
function keyFor(code: string) {
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  return { Comma: ",", Slash: "/" }[code] ?? code.toLowerCase();
}

function matches(b: Binding, e: KeyboardEvent) {
  return e.code ? b.key === e.code : keyFor(b.key) === e.key.toLowerCase();
}

export function installShortcuts() {
  const onKey = (e: KeyboardEvent) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const binding = BINDINGS.find(
      (b) => matches(b, e) && !!b.mod === mod && !!b.shift === e.shiftKey && !!b.alt === e.altKey,
    );
    if (!binding) return;
    e.preventDefault();
    runCommand(binding.id);
  };
  // Capture phase, so Monaco's own key handling doesn't swallow F7 etc.
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
