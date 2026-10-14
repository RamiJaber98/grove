import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./runCommand", () => ({ runCommand: vi.fn() }));

/** Loads a fresh copy of the module, so `isMac` is re-read from the user agent. */
async function load(userAgent?: string) {
  vi.resetModules();
  if (userAgent !== undefined) vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  const { installShortcuts } = await import("./shortcuts");
  const { runCommand } = await import("./runCommand");
  uninstall = installShortcuts();
  return vi.mocked(runCommand);
}

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

function press(init: KeyboardEventInit) {
  const e = new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });
  window.dispatchEvent(e);
  return e;
}

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

describe("installShortcuts (Windows/Linux)", () => {
  it("runs the bound command for Ctrl+key and prevents the default", async () => {
    const run = await load(WINDOWS_UA);
    const e = press({ code: "KeyO", key: "o", ctrlKey: true });
    expect(run).toHaveBeenCalledWith("open_repo");
    expect(e.defaultPrevented).toBe(true);
  });

  it("matches by code regardless of keyboard layout", async () => {
    const run = await load(WINDOWS_UA);
    // AZERTY: the physical KeyW key produces "z".
    press({ code: "KeyW", key: "z", ctrlKey: true });
    expect(run).toHaveBeenCalledWith("close_repo");
  });

  it("requires the exact modifiers", async () => {
    const run = await load(WINDOWS_UA);
    press({ code: "KeyO", key: "o" });
    press({ code: "KeyO", key: "o", metaKey: true });
    press({ code: "KeyO", key: "O", ctrlKey: true, shiftKey: true });
    press({ code: "KeyH", key: "h", ctrlKey: true });
    expect(run).not.toHaveBeenCalled();

    press({ code: "KeyH", key: "H", ctrlKey: true, shiftKey: true });
    expect(run).toHaveBeenCalledWith("show_history");
  });

  it("distinguishes F7 and Shift+F7, and Alt bindings", async () => {
    const run = await load(WINDOWS_UA);
    press({ code: "F7", key: "F7" });
    press({ code: "F7", key: "F7", shiftKey: true });
    press({ code: "KeyZ", key: "z", altKey: true });
    expect(run.mock.calls).toEqual([["next_change"], ["prev_change"], ["toggle_word_wrap"]]);
  });

  it("falls back to `key` for events without a `code`", async () => {
    const run = await load(WINDOWS_UA);
    press({ key: "o", ctrlKey: true });
    press({ key: ",", ctrlKey: true });
    press({ key: "/", ctrlKey: true });
    press({ key: "F5" });
    press({ key: "B", ctrlKey: true, shiftKey: true });
    expect(run.mock.calls).toEqual([["open_repo"], ["settings"], ["shortcuts"], ["refresh"], ["checkout_branch"]]);
  });

  it("ignores unbound keys without preventing the default", async () => {
    const run = await load(WINDOWS_UA);
    const e = press({ code: "KeyQ", key: "q", ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("stops listening once uninstalled", async () => {
    const run = await load(WINDOWS_UA);
    uninstall!();
    uninstall = undefined;
    press({ code: "F5", key: "F5" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("installShortcuts (macOS)", () => {
  it("uses Cmd as the modifier", async () => {
    const run = await load(MAC_UA);
    press({ code: "KeyO", key: "o", metaKey: true });
    expect(run).toHaveBeenCalledWith("open_repo");
  });

  it("does not treat Ctrl as the modifier", async () => {
    const run = await load(MAC_UA);
    press({ code: "KeyO", key: "o", ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
  });
});
