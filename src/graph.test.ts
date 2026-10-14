import { describe, expect, it } from "vitest";
import { layoutGraph } from "./graph";

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

describe("layoutGraph", () => {
  it("returns nothing for no commits", () => {
    expect(layoutGraph([])).toEqual([]);
  });

  it("keeps a linear history in one lane", () => {
    const rows = layoutGraph([c("C", "B"), c("B", "A"), c("A")]);
    expect(rows).toEqual([
      { lane: 0, top: [[0, 0]], bottom: [[0, 0]], width: 1 },
      { lane: 0, top: [[0, 0]], bottom: [[0, 0]], width: 1 },
      // The root has nothing below it.
      { lane: 0, top: [[0, 0]], bottom: [], width: 1 },
    ]);
  });

  it("draws a branch and its merge", () => {
    // M merges feature F into main; both come from A.
    const rows = layoutGraph([c("M", "A", "F"), c("F", "A"), c("A", "R"), c("R")]);
    expect(rows[0]).toEqual({
      lane: 0,
      top: [[0, 0]],
      // First parent continues down lane 0, the merged parent opens lane 1.
      bottom: [
        [0, 0],
        [0, 1],
      ],
      width: 2,
    });
    expect(rows[1]).toEqual({
      lane: 1,
      top: [
        [0, 0],
        [1, 1],
      ],
      // Main passes through; F joins back into the lane already waiting for A.
      bottom: [
        [0, 0],
        [1, 0],
      ],
      width: 2,
    });
    expect(rows[2]).toEqual({ lane: 0, top: [[0, 0]], bottom: [[0, 0]], width: 1 });
    expect(rows[3]).toEqual({ lane: 0, top: [[0, 0]], bottom: [], width: 1 });
  });

  it("opens one lane per parent for an octopus merge", () => {
    const rows = layoutGraph([c("M", "A", "B", "C"), c("A", "R"), c("B", "R"), c("C", "R"), c("R")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 2, 0]);
    expect(rows[0].bottom).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
    ]);
    expect(rows[0].width).toBe(3);
    // A takes R in lane 0; B and C converge into it.
    expect(rows[1].bottom).toEqual([
      [1, 1],
      [2, 2],
      [0, 0],
    ]);
    expect(rows[2].bottom).toEqual([
      [0, 0],
      [2, 2],
      [1, 0],
    ]);
    expect(rows[3]).toEqual({
      lane: 2,
      top: [
        [0, 0],
        [2, 2],
      ],
      bottom: [
        [0, 0],
        [2, 0],
      ],
      width: 3,
    });
    expect(rows[4]).toEqual({ lane: 0, top: [[0, 0]], bottom: [], width: 1 });
  });

  it("pulls a parent waited on further right into the leftmost lane", () => {
    // M's second parent B is also A's first parent. When A is drawn, lane 1
    // (waiting for B) is pulled into A's lane 0.
    const rows = layoutGraph([c("M", "A", "B"), c("A", "B"), c("B")]);
    expect(rows[0].bottom).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(rows[1]).toEqual({
      lane: 0,
      top: [
        [0, 0],
        [1, 1],
      ],
      bottom: [
        [0, 0],
        [1, 0],
      ],
      width: 2,
    });
    // B then sits in lane 0 rather than lane 1.
    expect(rows[2]).toEqual({ lane: 0, top: [[0, 0]], bottom: [], width: 1 });
  });

  it("pulls left when a new tip reuses a freed lane", () => {
    // T1's history ends (root Q), freeing lane 0; T3 takes lane 0 and pulls
    // P's lane over from lane 1.
    const rows = layoutGraph([c("T1", "Q"), c("T2", "P"), c("Q"), c("T3", "P"), c("P")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0, 0]);
    expect(rows[3].bottom).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(rows[3].width).toBe(2);
  });

  it("handles several unrelated roots", () => {
    const rows = layoutGraph([c("A", "R1"), c("B", "R2"), c("R1"), c("R2")]);
    expect(rows).toEqual([
      { lane: 0, top: [[0, 0]], bottom: [[0, 0]], width: 1 },
      {
        lane: 1,
        top: [
          [0, 0],
          [1, 1],
        ],
        bottom: [
          [0, 0],
          [1, 1],
        ],
        width: 2,
      },
      {
        lane: 0,
        top: [
          [0, 0],
          [1, 1],
        ],
        bottom: [[1, 1]],
        width: 2,
      },
      { lane: 1, top: [[1, 1]], bottom: [], width: 2 },
    ]);
  });
});
