import { network } from "../api/git";
import { useProgress } from "../progress";
import { useRepo } from "../store/repo";
import { Spinner } from "./Icons";

/**
 * The busy indicator: label, plus phase, progress bar and Cancel while a
 * network operation is running. Local operations just show the spinner.
 */
export function BusyProgress() {
  const busy = useRepo((s) => s.busy);
  const progress = useProgress((s) => s.progress);
  if (!busy && !progress) return null;
  return (
    <span className="status-busy" role="status">
      <Spinner size={12} /> {busy}
      {progress && (
        <>
          <span className="progress-phase">{progress.phase}</span>
          {progress.percent !== null && (
            <>
              <span
                className="progress-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress.percent}
                aria-label={progress.phase}
              >
                <span style={{ width: `${progress.percent}%` }} />
              </span>
              <span className="progress-percent">{progress.percent}%</span>
            </>
          )}
          <button className="progress-cancel" onClick={() => network.cancel()} title="Cancel this operation">
            Cancel
          </button>
        </>
      )}
    </span>
  );
}

/** Shown on the welcome screen (which has no status bar) while cloning. */
export function FloatingProgress() {
  const repo = useRepo((s) => s.repo);
  const busy = useRepo((s) => s.busy);
  if (repo || !busy) return null;
  return (
    <div className="floating-progress">
      <BusyProgress />
    </div>
  );
}
