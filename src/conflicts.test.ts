import { describe, expect, it } from "vitest";
import { detectEol, hasConflicts, parseConflicts, resolveText, sideLabels, splitLines } from "./conflicts";

const twoWay = ["a", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feature", "z", ""].join("\n");
const diff3 = ["<<<<<<< HEAD", "o1", "o2", "||||||| base", "b", "=======", "t", ">>>>>>> abc123 (Fix it)"].join("\n");

describe("parseConflicts", () => {
  it("finds two-way blocks with labels", () => {
    expect(parseConflicts(splitLines(twoWay))).toEqual([
      { start: 1, base: null, separator: 3, end: 5, oursLabel: "HEAD", theirsLabel: "feature" },
    ]);
  });

  it("finds diff3 blocks", () => {
    const [b] = parseConflicts(splitLines(diff3));
    expect(b).toMatchObject({ start: 0, base: 3, separator: 5, end: 7, theirsLabel: "abc123 (Fix it)" });
  });

  it("ignores lookalikes and incomplete blocks", () => {
    expect(parseConflicts(["Title", "========", "<<<<<<<< not", "text"])).toEqual([]);
    const lines = ["<<<<<<< HEAD", "dangling", "<<<<<<< HEAD", "x", "=======", "y", ">>>>>>> b"];
    expect(parseConflicts(lines)).toHaveLength(1);
    expect(parseConflicts(lines)[0].start).toBe(2);
  });

  it("handles CRLF text", () => {
    expect(hasConflicts(twoWay.replace(/\n/g, "\r\n"))).toBe(true);
    expect(hasConflicts("clean\r\n")).toBe(false);
  });
});

describe("resolveText", () => {
  it("applies each choice", () => {
    expect(resolveText(twoWay, "ours")).toBe("a\nours\nz\n");
    expect(resolveText(twoWay, "theirs")).toBe("a\ntheirs\nz\n");
    expect(resolveText(twoWay, "both")).toBe("a\nours\ntheirs\nz\n");
    expect(resolveText(diff3, "both")).toBe("o1\no2\nt");
    expect(resolveText(diff3, "base")).toBe("b");
  });

  it("resolves only the chosen blocks and keeps CRLF", () => {
    const text = [twoWay, twoWay].join("").replace(/\n/g, "\r\n");
    const out = resolveText(text, "theirs", [1]);
    expect(detectEol(out)).toBe("\r\n");
    expect(parseConflicts(splitLines(out))).toHaveLength(1);
    expect(out.endsWith("a\r\ntheirs\r\nz\r\n")).toBe(true);
  });
});

describe("sideLabels", () => {
  it("names merge sides directly", () => {
    const l = sideLabels({ operation: "merge", head: "main", incoming: "feature", rebaseBranch: null });
    expect(l.ours).toEqual({ title: "Current", detail: "main" });
    expect(l.theirs).toEqual({ title: "Incoming", detail: "feature" });
  });

  it("swaps sides during a rebase", () => {
    const l = sideLabels({ operation: "rebase", head: "main", incoming: "abc Fix", rebaseBranch: "feature" });
    expect(l.ours).toEqual({ title: "Incoming", detail: "main" });
    expect(l.theirs).toEqual({ title: "Current", detail: "feature: abc Fix" });
  });

  it("falls back to the marker label", () => {
    const l = sideLabels({ operation: null, head: "main", incoming: null, rebaseBranch: null }, "Stashed changes");
    expect(l.theirs.detail).toBe("Stashed changes");
  });
});
