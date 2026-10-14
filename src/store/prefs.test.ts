import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPref, savePref } from "./prefs";

afterEach(() => localStorage.clear());

describe("prefs", () => {
  it("round-trips values under the grove. prefix", () => {
    savePref("fontSize", 15);
    savePref("recent", ["/a", "/b"]);
    expect(localStorage.getItem("grove.fontSize")).toBe("15");
    expect(loadPref("fontSize", 13)).toBe(15);
    expect(loadPref<string[]>("recent", [])).toEqual(["/a", "/b"]);
  });

  it("returns the fallback for missing keys", () => {
    expect(loadPref("missing", "dflt")).toBe("dflt");
  });

  it("keeps stored falsy values", () => {
    savePref("wordWrap", false);
    expect(loadPref("wordWrap", true)).toBe(false);
  });

  it("returns the fallback for corrupt JSON", () => {
    localStorage.setItem("grove.theme", "{not json");
    expect(loadPref("theme", "system")).toBe("system");
  });

  it("returns the fallback when storage throws on read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(loadPref("theme", "dark")).toBe("dark");
  });

  it("swallows errors when storage throws on write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => savePref("theme", "light")).not.toThrow();
  });
});
