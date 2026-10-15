import { useEffect, useState } from "react";
import { errorMessage } from "../api/git";
import { extras, type SubmoduleDiff as Diff } from "../api/extras";
import { openSubmodule, updateSubmodule } from "../extrasActions";

/**
 * A submodule's change: the commit pointer before and after, and the commits
 * between them, with actions to update or open it.
 */
export default function SubmoduleDiff(props: { root: string; group: string; path: string; rev?: string; version?: number }) {
  const { root, group, path, rev, version } = props;
  const key = `${root}|${group}|${rev ?? ""}|${path}`;
  const [loaded, setLoaded] = useState<{ key: string; d?: Diff; error?: string } | null>(null);

  useEffect(() => {
    let stale = false;
    extras
      .submoduleDiff(root, group, path, rev)
      .then((d) => !stale && setLoaded({ key, d }))
      .catch((e) => !stale && setLoaded({ key, error: errorMessage(e) }));
    return () => {
      stale = true;
    };
  }, [key, version]);

  const current = loaded?.key === key ? loaded : null;
  if (!current) return <div className="empty">Loading…</div>;
  if (current.error) return <div className="empty error">{current.error}</div>;
  const d = current.d!;
  const short = (h: string | null) => (h ? h.slice(0, 10) : "none");

  return (
    <div className="submodule-diff">
      <div className="submodule-head">
        <div className="submodule-title">Submodule {path}</div>
        <div className="submodule-hashes">
          <code>{short(d.old)}</code> → <code>{short(d.new)}</code>
          {d.rewind && <span className="muted"> (moved back)</span>}
        </div>
        <div className="commit-actions">
          <button className="btn small" onClick={() => updateSubmodule(path)} title="git submodule update --init --recursive">
            Update Submodule
          </button>
          <button className="btn small" onClick={() => openSubmodule(path)} disabled={!d.initialized}>
            Open in New Window
          </button>
        </div>
      </div>
      {d.note && <div className="diff-notice">{d.note}</div>}
      {d.commits.length > 0 && (
        <div className="submodule-commits">
          <div className="dropdown-title">
            {d.commits.length}
            {d.commits.length >= 200 ? "+" : ""} commit{d.commits.length === 1 ? "" : "s"} {d.rewind ? "dropped" : "added"}
          </div>
          {d.commits.map((c) => (
            <div key={c.hash} className={`submodule-commit ${d.rewind ? "removed" : ""}`} title={c.hash}>
              <code>{c.short}</code> {c.subject}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
