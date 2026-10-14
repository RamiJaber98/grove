import { lazy, Suspense, useEffect, useState } from "react";
import { errorMessage, git, type FileVersions, type Side } from "../api/git";
import { runCommand } from "../runCommand";
import { useRepo, type DiffMode, type Group } from "../store/repo";
import type { DiffStats } from "./DiffEditor";
import { ArrowDown, ArrowUp } from "./Icons";
import ConflictView from "./ConflictView";

// Monaco is several MB; load it the first time a diff is shown.
const DiffEditor = lazy(() => import("./DiffEditor"));

const MODES: { mode: DiffMode; label: string }[] = [
  { mode: "side-by-side", label: "Side by side" },
  { mode: "inline", label: "Inline" },
];

const GROUP_LABEL: Record<Group, string> = {
  staged: "Staged",
  changes: "Working tree",
  conflicts: "Merge conflict",
  stash: "Stash",
};

type Loaded = { key: string; versions: FileVersions } | { key: string; error: string };

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Explains why a diff can't be shown as text, or returns null if it can. */
function unviewable(v: FileVersions): string | null {
  const sides = [v.original, v.modified].filter((s) => s.exists);
  const describe = (s: Side) => formatSize(s.size);
  if (sides.some((s) => s.binary)) {
    const sizes = [v.original, v.modified].map((s) => (s.exists ? describe(s) : "—")).join(" → ");
    return `Binary file (${sizes})`;
  }
  if (sides.some((s) => s.tooLarge)) {
    return `File is too large to display (${sides.map(describe).join(" → ")})`;
  }
  return null;
}

function FileDiffView() {
  const repo = useRepo((s) => s.repo)!;
  const selection = useRepo((s) => s.selection);
  const statusVersion = useRepo((s) => s.statusVersion);
  const diffMode = useRepo((s) => s.diffMode);
  const setDiffMode = useRepo((s) => s.setDiffMode);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [stats, setStats] = useState<DiffStats | null>(null);

  const key = selection ? `${selection.group}:${selection.stashRef ?? ""}:${selection.path}` : null;

  // Re-read on selection change and after every status refresh, so edits
  // made elsewhere show up in the open diff.
  useEffect(() => {
    if (!selection || !key) {
      setLoaded(null);
      return;
    }
    let stale = false;
    git
      .fileVersions(repo.root, selection.group, selection.path, selection.from, selection.stashRef)
      .then((versions) => !stale && setLoaded({ key, versions }))
      .catch((e) => !stale && setLoaded({ key, error: errorMessage(e) }));
    return () => {
      stale = true;
    };
  }, [repo.root, key, statusVersion]);

  useEffect(() => setStats(null), [key]);

  const current = loaded && loaded.key === key ? loaded : null;
  const versions = current && "versions" in current ? current.versions : null;
  const blocked = versions ? unviewable(versions) : null;
  const identical =
    versions && !blocked && versions.original.exists && versions.modified.exists &&
    versions.original.text === versions.modified.text;

  let body;
  if (!selection) {
    body = <Empty>Select a file on the right to see its changes.</Empty>;
  } else if (!current) {
    body = <Empty>Loading…</Empty>;
  } else if ("error" in current) {
    body = <Empty error>{current.error}</Empty>;
  } else if (blocked) {
    body = <Empty>{blocked}</Empty>;
  } else {
    body = (
      <>
        {identical && <div className="diff-notice">No content changes (only file mode or line endings differ).</div>}
        <Suspense fallback={<Empty>Loading editor…</Empty>}>
          <DiffEditor
            path={selection.path}
            original={versions!.original.text}
            modified={versions!.modified.text}
            onStats={setStats}
          />
        </Suspense>
      </>
    );
  }

  return (
    <section className="diff">
      <header className="diff-header">
        <div className="diff-title" title={selection?.path}>
          {selection ? (
            <>
              <span className="diff-file">{selection.path.split("/").pop()}</span>
              <span className="diff-dir">
                {selection.from && selection.from !== selection.path
                  ? `renamed from ${selection.from}`
                  : selection.path.split("/").slice(0, -1).join("/")}
              </span>
              <span className="diff-tag">{GROUP_LABEL[selection.group]}</span>
              {stats && !blocked && (
                <span className="diff-stats">
                  <span className="added">+{stats.added}</span>
                  <span className="removed">−{stats.removed}</span>
                </span>
              )}
            </>
          ) : (
            <span className="muted">No file selected</span>
          )}
        </div>
        {versions && !blocked && (
          <div className="diff-nav">
            <button className="icon-btn" title="Previous change (Shift+F7)" onClick={() => runCommand("prev_change")} disabled={!stats?.hunks}>
              <ArrowUp size={14} />
            </button>
            <button className="icon-btn" title="Next change (F7)" onClick={() => runCommand("next_change")} disabled={!stats?.hunks}>
              <ArrowDown size={14} />
            </button>
          </div>
        )}
        <div className="segmented" role="radiogroup" aria-label="Diff layout">
          {MODES.map(({ mode, label }) => (
            <button
              key={mode}
              role="radio"
              aria-checked={diffMode === mode}
              className={diffMode === mode ? "active" : ""}
              onClick={() => setDiffMode(mode)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      <div className="diff-body">{body}</div>
    </section>
  );
}

// Merge conflict editor: conflicted files open in the resolver instead of a diff.
export default function DiffView() {
  const selection = useRepo((s) => s.selection);
  return selection?.group === "conflicts" ? <ConflictView path={selection.path} /> : <FileDiffView />;
}

function Empty({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div className={`empty ${error ? "error" : ""}`}>
      <p>{children}</p>
    </div>
  );
}
