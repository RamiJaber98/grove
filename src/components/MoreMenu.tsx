import { useEffect, useRef, useState } from "react";
import { COMMANDS, MORE_MENU } from "../commands";
import { runCommand } from "../runCommand";
import { Dots } from "./Icons";

/** The ⋯ menu: every git command except Commit, Push and Pull. */
export default function MoreMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="more" ref={ref}>
      <button
        className={`icon-btn ${open ? "active" : ""}`}
        onClick={() => setOpen(!open)}
        title="More git commands"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Dots />
      </button>
      {open && (
        <div className="dropdown" role="menu">
          {MORE_MENU.map((section) => (
            <div key={section.title} className="dropdown-section">
              <div className="dropdown-title">{section.title}</div>
              {section.ids.filter((id) => COMMANDS[id].when?.() ?? true).map((id) => (
                <button
                  key={id}
                  role="menuitem"
                  className={`dropdown-item ${COMMANDS[id].danger ? "danger" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    runCommand(id);
                  }}
                >
                  {COMMANDS[id].label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
