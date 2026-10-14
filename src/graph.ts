/**
 * Lays out a commit graph for a list of commits in topological order
 * (children before parents). Each commit sits in a column ("lane"); lanes
 * carry the hash they're waiting for down the list until that commit appears.
 *
 * For each row we return line segments in two halves, so a row can be drawn
 * on its own: `top` runs from the row's top edge to the commit's middle,
 * `bottom` from the middle to the bottom edge. Each segment is a pair of
 * lane indexes (from, to).
 */
export interface GraphRow {
  lane: number;
  top: [number, number][];
  bottom: [number, number][];
  /** Number of lanes this row spans, for sizing. */
  width: number;
}

export function layoutGraph(commits: { hash: string; parents: string[] }[]): GraphRow[] {
  let lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];

  for (const { hash, parents } of commits) {
    let lane = lanes.indexOf(hash);
    if (lane === -1) {
      // A branch tip nothing above points to: take a free lane.
      lane = lanes.indexOf(null);
      if (lane === -1) lane = lanes.length;
    }
    const before = [...lanes];
    before[lane] ??= hash;

    // Top half: every waiting lane continues down; lanes waiting for this
    // commit (several children) converge into its lane.
    const top: [number, number][] = [];
    before.forEach((h, i) => {
      if (h === null) return;
      if (h === hash) top.push([i, lane]);
      else top.push([i, i]);
    });
    // Free every lane that was waiting for this commit.
    lanes = before.map((h) => (h === hash ? null : h));

    // This commit's lane now waits for its first parent; other parents join
    // an existing lane waiting for them, or get a new one.
    const links = new Set<number>();
    // Lanes pulled left into this commit's lane: [from, to].
    const moved: [number, number][] = [];
    if (parents.length) {
      const existing = lanes.indexOf(parents[0]);
      if (existing === -1) {
        lanes[lane] = parents[0];
        links.add(lane);
      } else if (existing > lane) {
        // Another lane already waits for this parent further right; pull it
        // into this lane so the line of history stays as far left as possible.
        lanes[existing] = null;
        lanes[lane] = parents[0];
        links.add(lane);
        moved.push([existing, lane]);
      } else {
        links.add(existing);
      }
      for (const p of parents.slice(1)) {
        let k = lanes.indexOf(p);
        if (k === -1) {
          k = lanes.indexOf(null);
          if (k === -1) k = lanes.length;
          lanes[k] = p;
        }
        links.add(k);
      }
    }

    // Bottom half: pass-through lanes go straight down, and the commit
    // connects to each of its parent lanes.
    const bottom: [number, number][] = [];
    lanes.forEach((h, k) => {
      if (h === null) return;
      if (k !== lane && before[k] === h) bottom.push([k, k]);
    });
    links.forEach((k) => bottom.push([lane, k]));
    bottom.push(...moved);

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ lane, top, bottom, width: Math.max(before.length, lanes.length, lane + 1) });
  }
  return rows;
}
