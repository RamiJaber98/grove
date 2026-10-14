import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { errorMessage, git, type ConflictFile, type Resolution, type Side } from "../api/git";
import { resolveWhole } from "../conflictActions";
import { describeSide, parseConflicts, sideLabels, splitLines, type SideLabel, type SideLabels } from "../conflicts";
import { useRepo } from "../store/repo";
import "./ConflictView.css";

// Both pull in Monaco; load on first use like the plain diff.
const ConflictEditor = lazy(() => import("./ConflictEditor"));
const DiffEditor = lazy(() => import("./DiffEditor"));

type Loaded = { path: string; file: ConflictFile } | { path: string; error: string };
type Mode = "resolve" | "compare";

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** "Both modified", "Deleted in Current", … named from the user's view. */
function describeCode(f: ConflictFile, l: SideLabels): string {
  switch (f.code) {
    case "UU":
      return "Both modified";
    case "AA":
      return "Both added";
    case "DU":
      return `Deleted in ${l.ours.title}`;
    case "UD":
      return `Deleted in ${l.theirs.title}`;
    case "AU":
      return `Added in ${l.ours.title}`;
    case "UA":
      return `Added in ${l.theirs.title}`;
    case "DD":
      return "Both deleted";
  }
}

/** Why the file can't be resolved line by line, or null if it can. */
function wholeFileReason(f: ConflictFile): string | null {
  const sides = [f.ours, f.theirs, f.working].filter((s) => s.exists);
  if (sides.some((s) => s.binary)) return "This is a binary file, so it can't be merged line by line.";
  if (sides.some((s) => s.tooLarge)) return "This file is too large to edit here.";
  if (!f.utf8) return "This file isn't UTF-8 text, so editing it here could corrupt it.";
  if (!f.working.exists) return "The conflicted file is missing from the working tree.";
  return null;
}

export default function ConflictView({ path }: { path: string }) {
  const repo = useRepo((s) => s.repo)!;
  const statusVersion = useRepo((s) => s.statusVersion);
  const busy = useRepo((s) => s.busy);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [mode, setMode] = useState<Mode>("resolve");

  // Re-read after every status refresh, so saves (here or elsewhere) show up.
  useEffect(() => {
    let stale = false;
    git
      .conflictFile(repo.root, path)
      .then((file) => !stale && setLoaded({ path, file }))
      .catch((e) => !stale && setLoaded({ path, error: errorMessage(e) }));
    return () => {
      stale = true;
    };
  }, [repo.root, path, statusVersion]);

  const current = loaded && loaded.path === path ? loaded : null;
  const file = current && "file" in current ? current.file : null;

  // Stable across reloads so the editor doesn't redraw for nothing.
  const ctxKey = file ? JSON.stringify(file.context) : "";
  const markerLabel = useMemo(() => {
    if (!file?.working.exists || file.working.binary) return undefined;
    return parseConflicts(splitLines(file.working.text))[0]?.theirsLabel;
  }, [file?.working.text]);
  const labels = useMemo(() => (file ? sideLabels(file.context, markerLabel) : null), [ctxKey, markerLabel]);

  const reason = file ? wholeFileReason(file) : null;
  const bothExist = !!file && file.ours.exists && file.theirs.exists;
  const canCompare = bothExist && !reason;
  const name = path.split("/").pop();

  let body;
  if (!current) {
    body = <Message>Loading…</Message>;
  } else if ("error" in current) {
    body = <Message error>{current.error}</Message>;
  } else if (!bothExist) {
    body = <DeleteCard path={path} file={file!} labels={labels!} busy={!!busy} />;
  } else if (reason) {
    body = <WholeFileCard path={path} file={file!} labels={labels!} reason={reason} busy={!!busy} />;
  } else if (mode === "compare") {
    body = (
      <>
        <div className="diff-notice">
          Left: {describeSide(labels!.ours, 60)} · Right: {describeSide(labels!.theirs, 60)}. Switch to Resolve to edit.
        </div>
        <Suspense fallback={<Message>Loading editor…</Message>}>
          <DiffEditor path={path} original={file!.ours.text} modified={file!.theirs.text} onStats={() => {}} />
        </Suspense>
      </>
    );
  } else {
    body = (
      <Suspense fallback={<Message>Loading editor…</Message>}>
        <ConflictEditor key={path} root={repo.root} path={path} text={file!.working.text} labels={labels!} />
      </Suspense>
    );
  }

  return (
    <section className="diff">
      <header className="diff-header">
        <div className="diff-title" title={path}>
          <span className="diff-file">{name}</span>
          <span className="diff-dir">{path.split("/").slice(0, -1).join("/")}</span>
          <span className="diff-tag">Merge conflict{file && labels ? ` · ${describeCode(file, labels)}` : ""}</span>
        </div>
        {canCompare && (
          <div className="segmented" role="radiogroup" aria-label="Conflict view">
            {(["resolve", "compare"] as const).map((m) => (
              <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
                {m === "resolve" ? "Resolve" : "Compare"}
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="diff-body">{body}</div>
    </section>
  );
}

interface CardProps {
  path: string;
  file: ConflictFile;
  labels: SideLabels;
  busy: boolean;
}

const sizeOf = (s: Side) => (s.exists ? formatSize(s.size) : "deleted");

/** One side deleted the file, the other changed (or kept) it. */
function DeleteCard({ path, file, labels, busy }: CardProps) {
  const kept: { resolution: Resolution; side: SideLabel } | null = file.ours.exists
    ? { resolution: "ours", side: labels.ours }
    : file.theirs.exists
      ? { resolution: "theirs", side: labels.theirs }
      : null;
  const deleter = file.ours.exists ? labels.theirs : labels.ours;
  return (
    <div className="conflict-wrap">
      <div className="conflict-card">
        {kept ? (
          <>
            <h3>{describeSide(deleter)} deleted this file</h3>
            <p>
              {describeSide(kept.side)} {file.base.exists ? "changed" : "added"} it. Keep that version, or delete the file.
            </p>
          </>
        ) : (
          <h3>Both sides deleted this file</h3>
        )}
        <div className="conflict-choices">
          {kept && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => resolveWhole(path, kept.resolution, `kept ${describeSide(kept.side)}`)}
            >
              Keep File
            </button>
          )}
          <button className="btn primary" disabled={busy} onClick={() => resolveWhole(path, "delete", "deleted")}>
            Delete File
          </button>
        </div>
      </div>
    </div>
  );
}

/** Binary / oversized / non-UTF-8: take one side wholesale. */
function WholeFileCard({ path, file, labels, reason, busy }: CardProps & { reason: string }) {
  // Current first, whichever git side it is.
  const order: Resolution[] = labels.ours.title === "Current" ? ["ours", "theirs"] : ["theirs", "ours"];
  return (
    <div className="conflict-wrap">
      <div className="conflict-card">
        <h3>Choose a version</h3>
        <p>{reason}</p>
        <p>
          {describeSide(labels.ours)}: {sizeOf(file.ours)} · {describeSide(labels.theirs)}: {sizeOf(file.theirs)}
        </p>
        <div className="conflict-choices">
          {order.map((r) => {
            const side = r === "ours" ? labels.ours : labels.theirs;
            return (
              <button key={r} className="btn" disabled={busy} onClick={() => resolveWhole(path, r, `took ${describeSide(side)}`)}>
                Take {describeSide(side)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Message({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div className={`empty ${error ? "error" : ""}`}>
      <p>{children}</p>
    </div>
  );
}
