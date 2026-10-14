import { lazy, Suspense, useEffect, useState } from "react";
import { errorMessage } from "../api/git";
import { fileHistoryApi, type Blame } from "../api/fileHistory";
import { useRepo } from "../store/repo";
import { openBlame, openFileHistory, useFileView } from "../store/fileView";

// Monaco loads on first use, as for diffs.
const BlameEditor = lazy(() => import("./BlameEditor"));

type Loaded = { key: string; blame: Blame } | { key: string; error: string };

/** The file at a revision, with who last changed each block of lines. */
export default function BlameView({ path }: { path: string }) {
  const repo = useRepo((s) => s.repo)!;
  const statusVersion = useRepo((s) => s.statusVersion);
  const rev = useFileView((s) => s.blameRev);
  const atPath = useFileView((s) => s.blamePath) ?? path;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const key = `${repo.root}:${rev ?? ""}:${atPath}`;
  // Only the working tree changes under us; a commit's blame never does.
  const version = rev === null ? statusVersion : 0;

  useEffect(() => {
    let stale = false;
    fileHistoryApi
      .blame(repo.root, atPath, rev)
      .then((blame) => !stale && setLoaded({ key, blame }))
      .catch((e) => !stale && setLoaded({ key, error: errorMessage(e) }));
    return () => {
      stale = true;
    };
  }, [key, repo.root, atPath, rev, version]);

  const current = loaded?.key === key ? loaded : null;
  const revs: { rev: string | null; label: string }[] = [
    { rev: null, label: "Working tree" },
    { rev: "HEAD", label: "HEAD" },
  ];
  if (rev && rev !== "HEAD") revs.push({ rev, label: rev.slice(0, 7) });

  let body;
  if (!current) body = <div className="empty">Loading…</div>;
  else if ("error" in current) body = <div className="empty error">{current.error}</div>;
  else if (current.blame.binary) body = <div className="empty">Binary file; nothing to blame.</div>;
  else if (current.blame.tooLarge) body = <div className="empty">File is too large to blame here.</div>;
  else
    body = (
      <Suspense fallback={<div className="empty">Loading editor…</div>}>
        <BlameEditor
          path={atPath}
          blame={current.blame}
          onPick={(hash) => openFileHistory(path, hash)}
        />
      </Suspense>
    );

  return (
    <>
      <div className="blame-bar">
        <span className="muted">Blame of</span>
        <div className="segmented" role="radiogroup" aria-label="Revision">
          {revs.map((r) => (
            <button
              key={r.rev ?? "worktree"}
              role="radio"
              aria-checked={rev === r.rev}
              className={rev === r.rev ? "active" : ""}
              onClick={() => openBlame(path, r.rev, r.rev === rev ? atPath : null)}
            >
              {r.label}
            </button>
          ))}
        </div>
        {atPath !== path && <span className="muted">as {atPath}</span>}
        <span className="spacer" />
        <span className="muted">Click an annotation to open that commit in File History.</span>
      </div>
      <div className="diff-body">{body}</div>
    </>
  );
}
