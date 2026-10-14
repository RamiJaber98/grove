/**
 * Conflict-marker parsing and resolution for the merge conflict editor.
 * Pure functions over text and line arrays (no Monaco, no React), so they
 * can be unit tested and reused.
 *
 * A block in the working file looks like:
 *
 *   <<<<<<< HEAD            ← start   (stage 2, "ours")
 *   ours…
 *   ||||||| base            ← base    (only with merge.conflictStyle=diff3/zdiff3)
 *   base…
 *   =======                 ← separator
 *   theirs…
 *   >>>>>>> feature         ← end     (stage 3, "theirs")
 */

export interface ConflictBlock {
  /** 0-based line indices of the marker lines. */
  start: number;
  base: number | null;
  separator: number;
  end: number;
  /** Text after the marker, e.g. "HEAD" or "feature". */
  oursLabel: string;
  theirsLabel: string;
}

/** Which part of a block to keep. "both" is ours followed by theirs. */
export type Choice = "ours" | "theirs" | "both" | "base";

const MARKER_LEN = 7;

/** The marker character a line starts with, if it's a conflict marker line. */
function markerOf(line: string): "<" | "|" | "=" | ">" | null {
  const c = line[0];
  if (c !== "<" && c !== "|" && c !== "=" && c !== ">") return null;
  if (line.length < MARKER_LEN) return null;
  for (let i = 1; i < MARKER_LEN; i++) if (line[i] !== c) return null;
  // Exactly seven, then end of line or a space before the label. "========"
  // (eight) is a Markdown/RST underline, not a marker.
  const next = line[MARKER_LEN];
  if (next !== undefined && next !== " " && next !== "\r") return null;
  if (c === "=" && line.slice(MARKER_LEN).trim() !== "") return null;
  return c;
}

const label = (line: string) => line.slice(MARKER_LEN).trim();

/** Splits text into lines, tolerating CRLF and LF. */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** The line ending a text mostly uses (LF when there are none). */
export function detectEol(text: string): "\n" | "\r\n" {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Finds well-formed conflict blocks. Incomplete ones (a start with no end,
 * e.g. half-edited by hand) are skipped rather than guessed at.
 */
export function parseConflicts(lines: string[]): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (markerOf(lines[i]) !== "<") {
      i++;
      continue;
    }
    const start = i;
    let base: number | null = null;
    let separator: number | null = null;
    let end: number | null = null;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const m = markerOf(lines[j]);
      if (m === "<") break; // a new block starts; this one was malformed
      if (m === "|" && separator === null && base === null) base = j;
      else if (m === "=" && separator === null) separator = j;
      else if (m === ">" && separator !== null) {
        end = j;
        break;
      }
    }
    if (separator !== null && end !== null) {
      blocks.push({
        start,
        base,
        separator,
        end,
        oursLabel: label(lines[start]),
        theirsLabel: label(lines[end]),
      });
      i = end + 1;
    } else {
      i = j < lines.length && markerOf(lines[j]) === "<" ? j : start + 1;
    }
  }
  return blocks;
}

/** True if the text still contains any conflict block. */
export function hasConflicts(text: string): boolean {
  return parseConflicts(splitLines(text)).length > 0;
}

/** The lines of each side of a block. */
export function blockSides(lines: string[], b: ConflictBlock) {
  return {
    ours: lines.slice(b.start + 1, b.base ?? b.separator),
    base: b.base === null ? [] : lines.slice(b.base + 1, b.separator),
    theirs: lines.slice(b.separator + 1, b.end),
  };
}

/** The lines that replace a whole block (markers included) for a choice. */
export function resolvedLines(lines: string[], b: ConflictBlock, choice: Choice): string[] {
  const s = blockSides(lines, b);
  switch (choice) {
    case "ours":
      return s.ours;
    case "theirs":
      return s.theirs;
    case "base":
      return s.base;
    case "both":
      return [...s.ours, ...s.theirs];
  }
}

/**
 * Resolves the blocks at `indices` (all blocks when omitted) and returns the
 * new text, keeping the text's line-ending style.
 */
export function resolveText(text: string, choice: Choice, indices?: number[]): string {
  const eol = detectEol(text);
  const lines = splitLines(text);
  const blocks = parseConflicts(lines);
  const pick = indices ? new Set(indices) : null;
  const out: string[] = [];
  let pos = 0;
  blocks.forEach((b, i) => {
    if (pick && !pick.has(i)) return;
    out.push(...lines.slice(pos, b.start), ...resolvedLines(lines, b, choice));
    pos = b.end + 1;
  });
  out.push(...lines.slice(pos));
  return out.join(eol);
}

// Naming the two sides. Git's "ours"/"theirs" mean HEAD and the other
// commit; what that means to the user depends on the operation.

export interface ConflictContext {
  operation: string | null;
  head: string | null;
  incoming: string | null;
  rebaseBranch: string | null;
}

export interface SideLabel {
  /** "Current" or "Incoming": whose change this is from the user's view. */
  title: string;
  /** Branch or commit, e.g. "main" or "a1b2c3d Fix parser". */
  detail: string | null;
}

export interface SideLabels {
  ours: SideLabel;
  theirs: SideLabel;
}

/**
 * During a merge, cherry-pick or revert, HEAD is the user's branch: ours =
 * Current, theirs = Incoming. During a rebase it's swapped: HEAD is the
 * upstream being rebuilt on (Incoming), and "theirs" is the user's own
 * commit being replayed (Current). `markerLabel` (from `>>>>>>> …`) is the
 * fallback name for the other side, e.g. "Stashed changes".
 */
export function sideLabels(ctx: ConflictContext, markerLabel?: string): SideLabels {
  const fallback = markerLabel || null;
  switch (ctx.operation) {
    case "rebase": {
      const mine = [ctx.rebaseBranch, ctx.incoming].filter(Boolean).join(": ");
      return {
        ours: { title: "Incoming", detail: ctx.head },
        theirs: { title: "Current", detail: mine || fallback },
      };
    }
    case "revert":
      return {
        ours: { title: "Current", detail: ctx.head },
        theirs: { title: "Incoming", detail: ctx.incoming ? `revert of ${ctx.incoming}` : fallback },
      };
    default:
      return {
        ours: { title: "Current", detail: ctx.head },
        theirs: { title: "Incoming", detail: ctx.incoming ?? fallback },
      };
  }
}

/** "Current (main)" */
export function describeSide(s: SideLabel, maxDetail = 40): string {
  if (!s.detail) return s.title;
  const d = s.detail.length > maxDetail ? `${s.detail.slice(0, maxDetail - 1)}…` : s.detail;
  return `${s.title} (${d})`;
}
