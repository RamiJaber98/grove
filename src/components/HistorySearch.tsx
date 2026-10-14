import { useEffect, useRef, useState } from "react";
import { git, type Branch, type Tag } from "../api/git";
import { setHistorySearchFocus } from "../historySearchHandle";
import { useRepo } from "../store/repo";

export type SearchMode = "message" | "author" | "path" | "hash";

export interface SearchFilter {
  mode: SearchMode;
  text: string;
  /** YYYY-MM-DD or "". */
  since: string;
  until: string;
}

export const EMPTY_FILTER: SearchFilter = { mode: "message", text: "", since: "", until: "" };

/** Which history to show: every ref, HEAD's ancestry, or one branch/tag. */
export type Scope = { kind: "all" } | { kind: "head" } | { kind: "ref"; name: string };

const DEBOUNCE_MS = 250;

const PLACEHOLDER: Record<SearchMode, string> = {
  message: "Search commit messages",
  author: "Author name or email",
  path: "File or folder path, e.g. src/app.ts",
  hash: "Commit hash (jumps to it)",
};

const scopeValue = (s: Scope) => (s.kind === "ref" ? `ref:${s.name}` : s.kind);
const parseScope = (v: string): Scope => (v.startsWith("ref:") ? { kind: "ref", name: v.slice(4) } : { kind: v as "all" | "head" });

/**
 * Search bar above the commit list. Typing is debounced so git isn't run on
 * every keystroke; the parent receives the settled filter.
 */
export default function HistorySearch({
  scope,
  onScope,
  onFilter,
  note,
}: {
  scope: Scope;
  onScope: (s: Scope) => void;
  onFilter: (f: SearchFilter) => void;
  /** Short status shown after the inputs (e.g. "No such commit"). */
  note?: string | null;
}) {
  const repo = useRepo((s) => s.repo)!;
  const statusVersion = useRepo((s) => s.statusVersion);
  const [filter, setFilter] = useState<SearchFilter>(EMPTY_FILTER);
  const [refs, setRefs] = useState<{ branches: Branch[]; tags: Tag[] }>({ branches: [], tags: [] });
  const input = useRef<HTMLInputElement>(null);
  const onFilterRef = useRef(onFilter);
  onFilterRef.current = onFilter;

  useEffect(() => {
    setHistorySearchFocus(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => setHistorySearchFocus(null);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => onFilterRef.current(filter), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filter]);

  useEffect(() => {
    let stale = false;
    Promise.all([git.branches(repo.root), git.tags(repo.root)])
      .then(([branches, tags]) => !stale && setRefs({ branches, tags }))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [repo.root, statusVersion]);

  const update = (patch: Partial<SearchFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const active = filter.text.trim() !== "" || filter.since !== "" || filter.until !== "";
  const local = refs.branches.filter((b) => !b.remote);
  const remote = refs.branches.filter((b) => b.remote);
  const known = scope.kind !== "ref" || refs.branches.some((b) => b.name === scope.name) || refs.tags.some((t) => t.name === scope.name);

  return (
    <div className="history-search" role="search">
      <select
        className="search-select"
        aria-label="Search in"
        value={filter.mode}
        onChange={(e) => update({ mode: e.target.value as SearchMode })}
      >
        <option value="message">Message</option>
        <option value="author">Author</option>
        <option value="path">Path</option>
        <option value="hash">Hash</option>
      </select>
      <input
        ref={input}
        className="search-input"
        type="search"
        spellCheck={false}
        placeholder={PLACEHOLDER[filter.mode]}
        value={filter.text}
        onChange={(e) => update({ text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          if (filter.text) update({ text: "" });
          else input.current?.blur();
        }}
      />
      <input
        className="search-date"
        type="date"
        aria-label="Since"
        title="Committed on or after"
        value={filter.since}
        max={filter.until || undefined}
        onChange={(e) => update({ since: e.target.value })}
      />
      <span className="muted">–</span>
      <input
        className="search-date"
        type="date"
        aria-label="Until"
        title="Committed on or before"
        value={filter.until}
        min={filter.since || undefined}
        onChange={(e) => update({ until: e.target.value })}
      />
      {active && (
        <button className="btn small" onClick={() => setFilter({ ...EMPTY_FILTER, mode: filter.mode })}>
          Clear
        </button>
      )}
      {note && <span className="search-note">{note}</span>}
      <select
        className="search-select search-scope"
        aria-label="Branch"
        title="Which history to show"
        value={scopeValue(scope)}
        onChange={(e) => onScope(parseScope(e.target.value))}
      >
        <option value="all">All branches</option>
        <option value="head">Current branch (HEAD)</option>
        {!known && scope.kind === "ref" && <option value={scopeValue(scope)}>{scope.name}</option>}
        {local.length > 0 && (
          <optgroup label="Branches">
            {local.map((b) => (
              <option key={b.name} value={`ref:${b.name}`}>
                {b.name}
              </option>
            ))}
          </optgroup>
        )}
        {remote.length > 0 && (
          <optgroup label="Remote branches">
            {remote.map((b) => (
              <option key={b.name} value={`ref:${b.name}`}>
                {b.name}
              </option>
            ))}
          </optgroup>
        )}
        {refs.tags.length > 0 && (
          <optgroup label="Tags">
            {refs.tags.map((t) => (
              <option key={t.name} value={`ref:${t.name}`}>
                {t.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}
