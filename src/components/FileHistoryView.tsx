import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { errorMessage, git, type FileVersions } from "../api/git";
import { fileHistoryApi, type FileLogEntry } from "../api/fileHistory";
import { ago } from "../refActions";
import { useRepo } from "../store/repo";
import { openBlame, useFileView } from "../store/fileView";

const DiffEditor = lazy(() => import("./DiffEditor"));

const PAGE = 300;
/** How far "jump to commit" (from Blame) pages ahead looking for a commit. */
const MAX_AUTO_PAGES = 10;

/** Commits that touched one file, following renames, with each one's diff of it. */
export default function FileHistoryView({ path }: { path: string }) {
  const repo = useRepo((s) => s.repo)!;
  const statusVersion = useRepo((s) => s.statusVersion);
  const selected = useFileView((s) => s.selected);
  const select = useFileView((s) => s.select);
  const [entries, setEntries] = useState<FileLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEntries(null);
    setLimit(PAGE);
  }, [repo.root, path]);

  useEffect(() => {
    let stale = false;
    fileHistoryApi
      .fileLog(repo.root, path, 0, limit)
      .then((e) => {
        if (stale) return;
        setEntries(e);
        setError(null);
      })
      .catch((e) => !stale && setError(errorMessage(e)));
    return () => {
      stale = true;
    };
  }, [repo.root, path, limit, statusVersion]);

  const more = !!entries && entries.length >= limit;
  const current = entries?.find((e) => e.hash === selected) ?? null;

  // Default to the newest commit; when asked for one that isn't loaded yet
  // (a jump from Blame), page further back until it shows up.
  useEffect(() => {
    if (!entries || current) return;
    if (selected && more && limit < PAGE * MAX_AUTO_PAGES) setLimit(limit + PAGE);
    else if (!selected && entries.length) select(entries[0].hash);
  }, [entries, current, selected, more, limit, select]);

  useEffect(() => {
    listRef.current?.querySelector(".commit-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <>
      <div className="history-list" role="listbox" aria-label="File commits" ref={listRef}>
        {error && <div className="empty error">{error}</div>}
        {!error && entries === null && <div className="empty">Loading…</div>}
        {entries?.length === 0 && <div className="empty">No commits touch this file yet.</div>}
        {entries?.map((c) => (
          <div
            key={c.hash}
            role="option"
            aria-selected={c.hash === selected}
            className={`commit-row file-log-row ${c.hash === selected ? "selected" : ""}`}
            onClick={() => select(c.hash)}
          >
            <span className={`kind kind-${c.kind || "M"}`}>{c.kind || "·"}</span>
            <span className="commit-subject">
              {c.subject}
              {c.path !== path && (
                <span className="file-log-path" title={c.path}>
                  {c.path}
                </span>
              )}
            </span>
            <span className="commit-author">{c.author}</span>
            <span className="commit-date" title={new Date(c.time * 1000).toLocaleString()}>
              {ago(c.time)}
            </span>
            <span className="commit-hash">{c.short}</span>
          </div>
        ))}
        {more && (
          <button className="btn small load-more" onClick={() => setLimit(limit + PAGE)}>
            Load more
          </button>
        )}
      </div>
      {current ? (
        <FileCommitPane entry={current} path={path} />
      ) : (
        <div className="commit-pane empty">{selected && entries ? "That commit isn't in this file's recent history." : "Select a commit to see how it changed the file."}</div>
      )}
    </>
  );
}

function FileCommitPane({ entry, path }: { entry: FileLogEntry; path: string }) {
  const repo = useRepo((s) => s.repo)!;
  const [versions, setVersions] = useState<FileVersions | null>(null);
  const [error, setError] = useState<string | null>(null);

  // parent → commit, reading the parent under the old name across a rename.
  useEffect(() => {
    let stale = false;
    setVersions(null);
    setError(null);
    git
      .fileVersions(repo.root, "commit", entry.path, entry.from ?? undefined, entry.hash)
      .then((v) => !stale && setVersions(v))
      .catch((e) => !stale && setError(errorMessage(e)));
    return () => {
      stale = true;
    };
  }, [repo.root, entry.hash, entry.path, entry.from]);

  const blocked = versions && [versions.original, versions.modified].some((s) => s.binary || s.tooLarge);
  const copyHash = () =>
    navigator.clipboard.writeText(entry.hash).then(() => useRepo.getState().toast("Copied commit hash."));

  return (
    <div className="file-commit-pane">
      <div className="file-commit-info">
        <span className="commit-title">{entry.subject}</span>
        <span className="muted">{entry.author}</span>
        <span className="muted">{new Date(entry.time * 1000).toLocaleString()}</span>
        <button className="link" title="Copy full hash" onClick={copyHash}>
          {entry.short}
        </button>
        {entry.from && entry.from !== entry.path && (
          <span className="muted" title={`${entry.from} → ${entry.path}`}>
            renamed from {entry.from}
          </span>
        )}
        <span className="spacer" />
        <button
          className="btn small"
          disabled={entry.kind === "D"}
          title="Blame the file as of this commit"
          onClick={() => openBlame(path, entry.hash, entry.path)}
        >
          Blame at {entry.short}
        </button>
      </div>
      <div className="commit-diff">
        {error ? (
          <div className="empty error">{error}</div>
        ) : !versions ? (
          <div className="empty">Loading…</div>
        ) : blocked ? (
          <div className="empty">Binary or very large file; no text diff.</div>
        ) : (
          <Suspense fallback={<div className="empty">Loading editor…</div>}>
            <DiffEditor
              path={entry.path}
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
