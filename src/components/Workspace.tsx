import { useCallback, useRef } from "react";
import { useRepo } from "../store/repo";
import ChangesPanel from "./ChangesPanel";
import CompareView, { CompareTab } from "./CompareView";
import DiffView from "./DiffView";
import HistoryView from "./HistoryView";
import StatusBar from "./StatusBar";

const MIN_PANEL = 260;
const MIN_DIFF = 320;

export default function Workspace() {
  const panelWidth = useRepo((s) => s.panelWidth);
  const setPanelWidth = useRepo((s) => s.setPanelWidth);
  const view = useRepo((s) => s.view);
  const setView = useRepo((s) => s.setView);
  const mainRef = useRef<HTMLDivElement>(null);

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const main = mainRef.current!;
      const handle = e.currentTarget as HTMLElement;
      handle.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent) => {
        const rect = main.getBoundingClientRect();
        const width = rect.right - ev.clientX;
        setPanelWidth(Math.round(Math.max(MIN_PANEL, Math.min(width, rect.width - MIN_DIFF))));
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    },
    [setPanelWidth],
  );

  return (
    <div className="workspace">
      <div className="main" ref={mainRef}>
        <div className="main-left">
          <nav className="tabs" role="tablist">
            {(["changes", "history"] as const).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                className={view === v ? "active" : ""}
                onClick={() => setView(v)}
                title={v === "history" ? "History (Ctrl+Shift+H)" : undefined}
              >
                {v === "changes" ? "Changes" : "History"}
              </button>
            ))}
            <CompareTab />
          </nav>
          {view === "compare" ? <CompareView /> : view === "changes" ? <DiffView /> : <HistoryView />}
        </div>
        <div className="splitter" onPointerDown={startResize} role="separator" aria-orientation="vertical" />
        <ChangesPanel width={panelWidth} />
      </div>
      <StatusBar />
    </div>
  );
}
