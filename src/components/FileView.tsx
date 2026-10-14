import { useRepo, type DiffMode } from "../store/repo";
import { useFileView, type FileMode } from "../store/fileView";
import BlameView from "./BlameView";
import FileHistoryView from "./FileHistoryView";
import { Refresh } from "./Icons";

const MODES: { mode: FileMode; label: string }[] = [
  { mode: "history", label: "History" },
  { mode: "blame", label: "Blame" },
];

const DIFF_MODES: { mode: DiffMode; label: string }[] = [
  { mode: "side-by-side", label: "Side by side" },
  { mode: "inline", label: "Inline" },
];

/** The File History / Blame tab: one file, two ways of looking at its past. */
export default function FileView() {
  const path = useFileView((s) => s.path);
  const mode = useFileView((s) => s.mode);
  const setMode = useFileView((s) => s.setMode);
  const diffMode = useRepo((s) => s.diffMode);
  const setDiffMode = useRepo((s) => s.setDiffMode);

  if (!path) {
    return (
      <section className="history">
        <div className="empty">
          <p>Select a file and choose History or Blame in its diff header.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="history">
      <header className="diff-header">
        <div className="diff-title" title={path}>
          <span className="diff-file">{path.split("/").pop()}</span>
          <span className="diff-dir">{path.split("/").slice(0, -1).join("/")}</span>
        </div>
        {mode === "history" && (
          <div className="segmented" role="radiogroup" aria-label="Diff layout">
            {DIFF_MODES.map((m) => (
              <button
                key={m.mode}
                role="radio"
                aria-checked={diffMode === m.mode}
                className={diffMode === m.mode ? "active" : ""}
                onClick={() => setDiffMode(m.mode)}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
        <div className="segmented" role="radiogroup" aria-label="File view">
          {MODES.map((m) => (
            <button
              key={m.mode}
              role="radio"
              aria-checked={mode === m.mode}
              className={mode === m.mode ? "active" : ""}
              onClick={() => setMode(m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <button className="icon-btn" title="Refresh" onClick={() => useRepo.getState().refresh()}>
          <Refresh />
        </button>
      </header>
      {mode === "history" ? <FileHistoryView path={path} /> : <BlameView path={path} />}
    </section>
  );
}
