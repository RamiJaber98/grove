import { lazy, Suspense, useEffect, useState } from "react";
import { errorMessage, git, type CompareFile, type Comparison, type FileVersions, type LogEntry } from "../api/git";
import { ago } from "../refActions";
import { closeCompare, updateCompare, useCompare } from "../store/compare";
import { useRepo } from "../store/repo";
import { Refresh } from "./Icons";

const DiffEditor = lazy(() => import("./DiffEditor"));

const TWO_DOT_HELP =
  "Two-dot (A..B): compares the two tips directly. Changes made on A after the branches split show up too, reversed.";
const THREE_DOT_HELP =
  "Three-dot (A...B): compares B with the point where it split from A (their merge base), so only B's own changes show. This is what a pull request shows.";

/** Tab button for the Compare view; only present while a comparison is open. */
export function CompareTab() {
  const target = useCompare((s) => s.target);
  const view = useRepo((s) => s.view);
  if (!target) return null;
  return (
    <button
      role="tab"
      aria-selected={view === "compare"}
      className={`compare-tab ${view === "compare" ? "active" : ""}`}
      onClick={() => useRepo.getState().setView("compare")}
    >
      Compare
      <span
        className="tab-close"
        role="button"
        aria-label="Close comparison"
        title="Close comparison"
        onClick={(e) => {
          e.stopPropagation();
          closeCompare();
        }}
      >
        ✕
      </span>
    </button>
  );
}

export default function CompareView() {
  const repo = useRepo((s) => s.repo)!;
  const statusVersion = useRepo((s) => s.statusVersion);
  const target = useCompare((s) => s.target);
  const [result, setResult] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"files" | "commits">("files");
  const [file, setFile] = useState<CompareFile | null>(null);
  const [versions, setVersions] = useState<FileVersions | null>(null);

  // statusVersion: a working-tree compare must follow edits on disk, and
  // branch tips move on commit/fetch.
  useEffect(() => {
    if (!target) return;
    let stale = false;
    git
      .compare(repo.root, target.a, target.b, target.threeDot)
      .then((r) => {
        if (stale) return;
        setResult(r);
        setError(null);
        // Keep the open file across refreshes if it's still in the list.
        setFile((f) => r.files.find((x) => x.path === f?.path) ?? r.files[0] ?? null);
      })
      .catch((e) => {
        if (stale) return;
        setResult(null);
        setFile(null);
        setError(errorMessage(e));
      });
    return () => {
      stale = true;
    };
  }, [repo.root, statusVersion, target]);

  useEffect(() => {
    if (!file || !result) return setVersions(null);
    let stale = false;
    git
      .refVersions(repo.root, result.base, result.head, file.path, file.from ?? undefined)
      .then((v) => !stale && setVersions(v))
      .catch((e) => !stale && setError(errorMessage(e)));
    return () => {
      stale = true;
    };
  }, [repo.root, result, file]);

  if (!target) return <div className="empty">No comparison open. Use Branch › Compare….</div>;

  const aName = target.aLabel ?? target.a;
  const bName = target.b === null ? "Working tree" : (target.bLabel ?? target.b);
  const blocked = versions && [versions.original, versions.modified].some((s) => s.binary || s.tooLarge);
  const totals = result?.files.reduce((t, f) => [t[0] + (f.added ?? 0), t[1] + (f.removed ?? 0)], [0, 0]);

  return (
    <section className="history compare">
      <header className="diff-header">
        <div className="diff-title" title={`${aName} ${target.threeDot ? "..." : ".."} ${bName}`}>
          <span className="diff-file">{aName}</span>
          <span className="muted">{target.threeDot ? "…" : ".."}</span>
          <span className="diff-file">{bName}</span>
          {totals && (
            <span className="diff-stats">
              <span className="added">+{totals[0]}</span>
              <span className="removed">−{totals[1]}</span>
            </span>
          )}
        </div>
        <button
          className="btn small"
          disabled={target.b === null}
          title={target.b === null ? "The working tree is always the B side." : "Swap A and B"}
          onClick={() =>
            target.b !== null &&
            updateCompare({ a: target.b, aLabel: target.bLabel, b: target.a, bLabel: target.aLabel })
          }
        >
          ⇄ Swap
        </button>
        <div className="segmented" role="radiogroup" aria-label="Comparison type">
          <button
            role="radio"
            aria-checked={!target.threeDot}
            className={!target.threeDot ? "active" : ""}
            title={TWO_DOT_HELP}
            onClick={() => updateCompare({ threeDot: false })}
          >
            A..B
          </button>
          <button
            role="radio"
            aria-checked={target.threeDot}
            className={target.threeDot ? "active" : ""}
            title={THREE_DOT_HELP}
            onClick={() => updateCompare({ threeDot: true })}
          >
            A...B
          </button>
        </div>
        <button className="icon-btn" title="Refresh" onClick={() => useRepo.getState().refresh()}>
          <Refresh />
        </button>
        <button className="icon-btn" title="Close comparison" aria-label="Close comparison" onClick={closeCompare}>
          ✕
        </button>
      </header>

      {error && <div className="diff-notice error">{error}</div>}

      <div className="commit-pane">
        <div className="commit-info compare-side">
          <div className="segmented compare-tabs" role="tablist">
            <button role="tab" aria-selected={tab === "files"} className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
              Files{result ? ` (${result.files.length})` : ""}
            </button>
            <button role="tab" aria-selected={tab === "commits"} className={tab === "commits" ? "active" : ""} onClick={() => setTab("commits")}>
              Commits{result ? ` (${result.ahead.length + result.behind.length})` : ""}
            </button>
          </div>
          {!result ? (
            !error && <div className="empty">Comparing…</div>
          ) : tab === "files" ? (
            <div className="commit-files">
              {result.files.map((f) => (
                <div
                  key={f.path}
                  role="button"
                  tabIndex={0}
                  className={`file ${file?.path === f.path ? "selected" : ""} ${f.kind === "D" ? "deleted" : ""}`}
                  title={f.from ? `${f.from} → ${f.path}` : f.path}
                  onClick={() => setFile(f)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setFile(f)}
                >
                  <span className="file-name">{f.path.split("/").pop()}</span>
                  <span className="file-dir">{f.path.split("/").slice(0, -1).join("/")}</span>
                  <span className="numstat">
                    {f.added === null ? (
                      <span className="muted">bin</span>
                    ) : (
                      <>
                        <span className="added">+{f.added}</span> <span className="removed">−{f.removed}</span>
                      </>
                    )}
                  </span>
                  <span className={`kind kind-${f.kind}`}>{f.kind}</span>
                </div>
              ))}
              {result.files.length === 0 && <div className="group-empty">No differences.</div>}
            </div>
          ) : (
            <div className="commit-files">
              <CommitList title={`In ${bName}, not in ${aName}`} commits={result.ahead} />
              <CommitList title={`In ${aName}, not in ${bName}`} commits={result.behind} />
            </div>
          )}
        </div>
        <div className="commit-diff">
          {!file ? (
            <div className="empty">{result ? (result.files.length ? "Select a file." : "No differences.") : ""}</div>
          ) : !versions ? (
            <div className="empty">Loading…</div>
          ) : blocked ? (
            <div className="empty">Binary or very large file; no text diff.</div>
          ) : (
            <Suspense fallback={<div className="empty">Loading editor…</div>}>
              <DiffEditor path={file.path} original={versions.original.text} modified={versions.modified.text} onStats={() => {}} />
            </Suspense>
          )}
        </div>
      </div>
    </section>
  );
}

/** Commits on one side only (`A..B` or `B..A`). The working tree's side is HEAD. */
function CommitList({ title, commits }: { title: string; commits: LogEntry[] }) {
  return (
    <div className="compare-commits">
      <div className="section-label">
        {title} ({commits.length >= 1000 ? "1000+" : commits.length})
      </div>
      {commits.length === 0 && <div className="group-empty">None.</div>}
      {commits.map((c) => (
        <div
          key={c.hash}
          className="compare-commit"
          title={`${c.subject}\n${c.author} · ${new Date(c.time * 1000).toLocaleString()}\nClick to copy the hash`}
          onClick={() => navigator.clipboard.writeText(c.hash).then(() => useRepo.getState().toast("Copied commit hash."))}
        >
          <span className="commit-hash">{c.short}</span>
          <span className="commit-subject">{c.subject}</span>
          <span className="commit-date">{ago(c.time)}</span>
        </div>
      ))}
    </div>
  );
}
