import { useRepo, type DiffMode } from "../store/repo";

const MODES: { mode: DiffMode; label: string }[] = [
  { mode: "side-by-side", label: "Side by side" },
  { mode: "inline", label: "Inline" },
];

export default function DiffView() {
  const selection = useRepo((s) => s.selection);
  const diffMode = useRepo((s) => s.diffMode);
  const setDiffMode = useRepo((s) => s.setDiffMode);

  return (
    <section className="diff">
      <header className="diff-header">
        <div className="diff-title" title={selection?.path}>
          {selection ? (
            <>
              <span className="diff-file">{selection.path.split("/").pop()}</span>
              <span className="diff-dir">{selection.path.split("/").slice(0, -1).join("/")}</span>
            </>
          ) : (
            <span className="muted">No file selected</span>
          )}
        </div>
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
      <div className="diff-body">
        {/* Phase 3 mounts the Monaco diff editor here. */}
        <div className="empty">
          <p>Select a file on the right to see its changes.</p>
        </div>
      </div>
    </section>
  );
}
