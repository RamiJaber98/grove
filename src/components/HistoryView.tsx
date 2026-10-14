import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, git, type CommitDetail, type FileChange, type FileVersions, type LogEntry, type LogQuery } from "../api/git";
import { layoutGraph, type GraphRow } from "../graph";
import * as refs from "../refActions";
import { pick } from "../dialogs";
import { useRepo } from "../store/repo";
import { loadPref, savePref } from "../store/prefs";
import { openCompare } from "../store/compare";
import HistorySearch, { EMPTY_FILTER, type Scope, type SearchFilter } from "./HistorySearch";
import { Refresh } from "./Icons";
import { openInteractiveRebase } from "../rebase";

const DiffEditor = lazy(() => import("./DiffEditor"));

const PAGE = 300;
const ROW_H = 26;
const LANE_W = 14;
const LANE_COLORS = ["#3fa463", "#6ea4f5", "#d9b44a", "#e07ac0", "#f08c4a", "#5fc2c2", "#a98cf0", "#ef6b6b"];
const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

type Query = Omit<LogQuery, "skip" | "limit">;

/** The search bar's state as a git query, or null for the plain log. */
function toQuery(filter: SearchFilter, scope: Scope): Query | null {
  const q: Query = {};
  const text = filter.text.trim();
  if (text && filter.mode !== "hash") q[filter.mode] = text;
  if (filter.since) q.since = filter.since;
  if (filter.until) q.until = filter.until;
  if (scope.kind === "ref") q.rev = scope.name;
  if (Object.keys(q).length === 0) return null;
  q.all = scope.kind === "all";
  return q;
}

export default function HistoryView() {
  const repo = useRepo((s) => s.repo)!;
  const statusVersion = useRepo((s) => s.statusVersion);
  const [scope, setScope] = useState<Scope>(() => (loadPref("historyAll", false) ? { kind: "all" } : { kind: "head" }));
  const [filter, setFilter] = useState<SearchFilter>(EMPTY_FILTER);
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(null);
  // Ctrl/Cmd+click marks up to two commits for "Compare selected".
  const [picked, setPicked] = useState<string[]>([]);
  // Result of a hash search: the commit it names, or null for no match.
  const [jump, setJump] = useState<{ text: string; entry: LogEntry | null } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const all = scope.kind === "all";
  const query = useMemo(() => toQuery(filter, scope), [filter, scope]);
  const queryKey = JSON.stringify(query);
  // Message, author, path and date filters drop the commits in between, so
  // parent links point at rows that aren't shown and the lane layout would
  // draw lines that go nowhere. The graph is hidden while one is active; a
  // branch/tag scope keeps the full ancestry, so its graph stays.
  const filtered = query !== null && Object.keys(query).some((k) => k !== "rev" && k !== "all");

  // Reload when the repo changes (new commits, branch switches) or options change.
  useEffect(() => {
    let stale = false;
    const load = query ? git.searchLog(repo.root, { ...query, skip: 0, limit }) : git.log(repo.root, 0, limit, all);
    load
      .then((e) => {
        if (stale) return;
        setEntries(e);
        setError(null);
      })
      .catch((e) => {
        if (stale) return;
        setEntries([]);
        setError(errorMessage(e));
      });
    return () => {
      stale = true;
    };
    // queryKey stands in for query, which is a new object on every filter change.
  }, [repo.root, statusVersion, all, limit, queryKey]);

  // Hash mode doesn't filter the list: it resolves the prefix and jumps to it.
  useEffect(() => {
    const text = filter.text.trim();
    if (filter.mode !== "hash" || !text) return setJump(null);
    if (!/^[0-9a-f]{4,64}$/i.test(text)) return setJump({ text, entry: null });
    let stale = false;
    git
      .searchLog(repo.root, { skip: 0, limit: 1, hash: text })
      .then((r) => !stale && setJump({ text, entry: r[0] ?? null }))
      .catch(() => !stale && setJump({ text, entry: null }));
    return () => {
      stale = true;
    };
  }, [repo.root, filter.mode, filter.text]);

  useEffect(() => {
    if (!jump?.entry) return;
    setSelected(jump.entry.hash);
    setPicked([]);
  }, [jump]);

  // Keep the selected commit visible (after a jump, or keyboard-free paging).
  useEffect(() => {
    if (!selected) return;
    listRef.current?.querySelector(`[data-hash="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, entries]);

  // A jump to a commit outside the loaded list (another branch, or older
  // than the loaded pages) shows that commit on its own.
  const outside = !!jump?.entry && !!entries && !entries.some((e) => e.hash === jump.entry!.hash);
  const shown = outside ? [jump!.entry!] : entries;
  const graph = useMemo(() => (shown && !filtered && !outside ? layoutGraph(shown) : []), [shown, filtered, outside]);
  const graphWidth = Math.min(Math.max(1, ...graph.map((r) => r.width)), 12) * LANE_W + 6;
  const current = shown?.find((e) => e.hash === selected) ?? null;
  const pickedRows = (shown ?? []).filter((e) => picked.includes(e.hash));

  const note = !jump
    ? null
    : !jump.entry
      ? "No commit with that hash."
      : outside
        ? "Not in the list above; shown on its own."
        : null;

  const select = (hash: string, multi: boolean) => {
    setSelected(hash);
    if (!multi) return setPicked([]);
    setPicked((p) => {
      if (p.includes(hash)) return p.filter((h) => h !== hash);
      // The first Ctrl+click pairs with the commit that was already selected.
      const base = p.length ? p : selected && selected !== hash ? [selected] : [];
      return [...base, hash].slice(-2);
    });
  };

  const comparePicked = () => {
    // List order is newest first, so the later row is the older commit: A.
    const [newer, older] = pickedRows;
    openCompare({ a: older.hash, aLabel: older.short, b: newer.hash, bLabel: newer.short });
  };

  const changeScope = (s: Scope) => {
    setScope(s);
    setLimit(PAGE);
    if (s.kind !== "ref") savePref("historyAll", s.kind === "all");
  };

  return (
    <section className="history">
      <header className="diff-header">
        <div className="diff-title">
          <span className="diff-file">History</span>
          {shown && !outside && (
            <span className="diff-dir">
              {shown.length}
              {shown.length >= limit ? "+" : ""} {filtered ? (shown.length === 1 ? "result" : "results") : "commits"}
            </span>
          )}
        </div>
        {pickedRows.length === 2 && (
          <button className="btn small" title="Compare the two selected commits (older … newer)" onClick={comparePicked}>
            Compare selected
          </button>
        )}
        <button className="icon-btn" title="Refresh" onClick={() => useRepo.getState().refresh()}>
          <Refresh />
        </button>
      </header>

      <HistorySearch
        scope={scope}
        onScope={changeScope}
        onFilter={(f) => {
          setFilter(f);
          setLimit(PAGE);
        }}
        note={note}
      />

      <div className="history-list" role="listbox" aria-label="Commits" aria-multiselectable="true" ref={listRef}>
        {error && <div className="empty error">{error}</div>}
        {!error && shown === null && <div className="empty">Loading…</div>}
        {!error && shown?.length === 0 && <div className="empty">{query ? "No commits match." : "No commits yet."}</div>}
        {shown?.map((c, i) => (
          <div
            key={c.hash}
            data-hash={c.hash}
            role="option"
            aria-selected={c.hash === selected || picked.includes(c.hash)}
            className={`commit-row ${c.hash === selected ? "selected" : ""} ${picked.includes(c.hash) ? "picked" : ""}`}
            onClick={(e) => select(c.hash, e.ctrlKey || e.metaKey)}
          >
            {graph.length > 0 && <GraphCell row={graph[i]} width={graphWidth} merge={c.parents.length > 1} />}
            <span className="commit-subject">
              {c.refs.filter((r) => !r.endsWith("/HEAD")).map((r) => (
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
        {shown && !outside && shown.length >= limit && (
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
          <button
            className="btn small"
            title="Reorder, reword, squash or drop the commits after this one"
            onClick={() => openInteractiveRebase({ base: entry.hash, label: entry.short })}
          >
            Rebase from Here…
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
