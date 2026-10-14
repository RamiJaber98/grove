import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { errorMessage, git, type CommitDetail, type FileChange, type FileVersions, type LogEntry } from "../api/git";
import { layoutGraph, type GraphRow } from "../graph";
import * as refs from "../refActions";
import { pick } from "../dialogs";
import { useRepo } from "../store/repo";
import { loadPref, savePref } from "../store/prefs";
import { Refresh } from "./Icons";

const DiffEditor = lazy(() => import("./DiffEditor"));

const PAGE = 300;
const ROW_H = 26;
const LANE_W = 14;
const LANE_COLORS = ["#3fa463", "#6ea4f5", "#d9b44a", "#e07ac0", "#f08c4a", "#5fc2c2", "#a98cf0", "#ef6b6b"];
const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

export default function HistoryView() {
  const repo = useRepo((s) => s.repo)!;
  const statusVersion = useRepo((s) => s.statusVersion);
  const [all, setAll] = useState(() => loadPref("historyAll", false));
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(null);

  // Reload when the repo changes (new commits, branch switches) or options change.
  useEffect(() => {
    let stale = false;
    git
      .log(repo.root, 0, limit, all)
      .then((e) => {
        if (stale) return;
        setEntries(e);
        setError(null);
      })
      .catch((e) => !stale && setError(errorMessage(e)));
    return () => {
      stale = true;
    };
  }, [repo.root, statusVersion, all, limit]);

  const graph = useMemo(() => (entries ? layoutGraph(entries) : []), [entries]);
  const graphWidth = Math.min(Math.max(1, ...graph.map((r) => r.width)), 12) * LANE_W + 6;
  const current = entries?.find((e) => e.hash === selected) ?? null;

  return (
    <section className="history">
      <header className="diff-header">
        <div className="diff-title">
          <span className="diff-file">History</span>
          {entries && (
            <span className="diff-dir">
              {entries.length}
              {entries.length >= limit ? "+" : ""} commits
            </span>
          )}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => {
              setAll(e.target.checked);
              savePref("historyAll", e.target.checked);
            }}
          />
          All branches
        </label>
        <button className="icon-btn" title="Refresh" onClick={() => useRepo.getState().refresh()}>
          <Refresh />
        </button>
      </header>

      <div className="history-list" role="listbox" aria-label="Commits">
        {error && <div className="empty error">{error}</div>}
        {!error && entries === null && <div className="empty">Loading…</div>}
        {entries?.length === 0 && <div className="empty">No commits yet.</div>}
        {entries?.map((c, i) => (
          <div
            key={c.hash}
            role="option"
            aria-selected={c.hash === selected}
            className={`commit-row ${c.hash === selected ? "selected" : ""}`}
            onClick={() => setSelected(c.hash)}
          >
            <GraphCell row={graph[i]} width={graphWidth} merge={c.parents.length > 1} />
            <span className="commit-subject">
              {c.refs.map((r) => (
                <RefBadge key={r} name={r} />
              ))}
              {c.subject}
            </span>
            <span className="commit-author">{c.author}</span>
            <span className="commit-date" title={new Date(c.time * 1000).toLocaleString()}>
              {refs.ago(c.time)}
            </span>
            <span className="commit-hash">{c.short}</span>
          </div>
        ))}
        {entries && entries.length >= limit && (
          <button className="btn small load-more" onClick={() => setLimit(limit + PAGE)}>
            Load more
          </button>
        )}
      </div>

      {current ? <CommitPane entry={current} /> : <div className="commit-pane empty">Select a commit to see its changes.</div>}
    </section>
  );
}

function GraphCell({ row, width, merge }: { row: GraphRow | undefined; width: number; merge: boolean }) {
  if (!row) return <span style={{ width }} />;
  const x = (lane: number) => lane * LANE_W + LANE_W / 2 + 2;
  const mid = ROW_H / 2;
  return (
    <svg className="graph" width={width} height={ROW_H} aria-hidden="true">
      {row.top.map(([a, b], i) => (
        <path key={`t${i}`} d={`M${x(a)} 0 C${x(a)} ${mid / 2} ${x(b)} ${mid / 2} ${x(b)} ${mid}`} stroke={laneColor(a)} />
      ))}
      {row.bottom.map(([a, b], i) => (
        <path
          key={`b${i}`}
          d={`M${x(a)} ${mid} C${x(a)} ${mid * 1.5} ${x(b)} ${mid * 1.5} ${x(b)} ${ROW_H}`}
          stroke={laneColor(b)}
        />
      ))}
      <circle
        cx={x(row.lane)}
        cy={mid}
        r={merge ? 3 : 4}
        fill={merge ? "var(--bg)" : laneColor(row.lane)}
        stroke={laneColor(row.lane)}
        strokeWidth={merge ? 2 : 0}
      />
    </svg>
  );
}

function RefBadge({ name }: { name: string }) {
  const head = name.startsWith("HEAD -> ");
  const tag = name.startsWith("tag: ");
  const label = head ? name.slice(8) : tag ? name.slice(5) : name;
  const kind = head || name === "HEAD" ? "head" : tag ? "tag" : name.includes("/") ? "remote" : "local";
  return <span className={`ref-badge ${kind}`}>{label}</span>;
}

function CommitPane({ entry }: { entry: LogEntry }) {
  const repo = useRepo((s) => s.repo)!;
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<FileChange | null>(null);
  const [versions, setVersions] = useState<FileVersions | null>(null);

  useEffect(() => {
    let stale = false;
    setDetail(null);
    setFile(null);
    git
      .commitDetail(repo.root, entry.hash)
      .then((d) => {
        if (stale) return;
        setDetail(d);
        setError(null);
        setFile(d.files[0] ?? null);
      })
      .catch((e) => !stale && setError(errorMessage(e)));
    return () => {
      stale = true;
    };
  }, [repo.root, entry.hash]);

  useEffect(() => {
    if (!file) return setVersions(null);
    let stale = false;
    setVersions(null);
    git
      .fileVersions(repo.root, "commit", file.path, file.from, entry.hash)
      .then((v) => !stale && setVersions(v))
      .catch((e) => !stale && setError(errorMessage(e)));
    return () => {
      stale = true;
    };
  }, [repo.root, entry.hash, file]);

  const c = { hash: entry.hash, short: entry.short, subject: entry.subject };
  const [subject, ...body] = (detail?.message ?? entry.subject).split("\n");
  const blocked = versions && [versions.original, versions.modified].some((s) => s.binary || s.tooLarge);

  return (
    <div className="commit-pane">
      <div className="commit-info">
        <div className="commit-message">
          <div className="commit-title">{subject}</div>
          {body.join("\n").trim() && <pre className="commit-body">{body.join("\n").trim()}</pre>}
        </div>
        <div className="commit-meta">
          <span>{entry.author}</span>
          {detail?.email && <span className="muted">&lt;{detail.email}&gt;</span>}
          <span className="muted">{new Date(entry.time * 1000).toLocaleString()}</span>
          <button className="link" title="Copy full hash" onClick={() => navigator.clipboard.writeText(entry.hash).then(() => useRepo.getState().toast("Copied commit hash."))}>
            {entry.short}
          </button>
          {entry.parents.length > 1 && <span className="muted">merge of {entry.parents.map((p) => p.slice(0, 7)).join(" + ")}</span>}
        </div>
        <div className="commit-actions">
          <button className="btn small" onClick={() => refs.checkoutCommit(c)}>Checkout</button>
          <button className="btn small" onClick={() => refs.branchAt(c)}>Branch…</button>
          <button className="btn small" onClick={() => refs.tagAt(c)}>Tag…</button>
          <button className="btn small" onClick={() => refs.cherryPickCommit(c)}>Cherry-Pick</button>
          <button className="btn small" onClick={() => refs.revertCommit(c)}>Revert</button>
          <button
            className="btn small"
            onClick={async () => {
              const mode = await pick({
                title: `Reset ${useRepo.getState().branch ?? "HEAD"} to ${entry.short}`,
                items: [
                  { label: "Soft", detail: "keep changes staged", value: "soft" as const },
                  { label: "Mixed", detail: "keep changes in files, unstaged", value: "mixed" as const },
                  { label: "Hard", detail: "discard all changes", value: "hard" as const },
                ],
              });
              if (mode) refs.resetTo(mode, { ...c, author: entry.author, time: entry.time });
            }}
          >
            Reset…
          </button>
        </div>
        {error && <div className="empty error">{error}</div>}
        <div className="commit-files">
          {detail?.files.map((f) => (
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
              <span className={`kind kind-${f.kind}`}>{f.kind}</span>
            </div>
          ))}
          {detail && detail.files.length === 0 && <div className="group-empty">No file changes.</div>}
        </div>
      </div>
      <div className="commit-diff">
        {!file ? (
          <div className="empty">{detail ? "Select a file." : "Loading…"}</div>
        ) : !versions ? (
          <div className="empty">Loading…</div>
        ) : blocked ? (
          <div className="empty">Binary or very large file; no text diff.</div>
        ) : (
          <Suspense fallback={<div className="empty">Loading editor…</div>}>
            <DiffEditor
              path={file.path}
              original={versions.original.text}
              modified={versions.modified.text}
              onStats={() => {}}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
