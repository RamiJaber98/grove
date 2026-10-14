import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { errorMessage, git, isTauri } from "../api/git";
import { openPanel, usePanel } from "../dialogs";
import { useRepo, type DiffMode, type Theme } from "../store/repo";
import Logo from "./Logo";

const isMac = navigator.userAgent.includes("Mac");
const mod = isMac ? "⌘" : "Ctrl";

/** Settings, Keyboard Shortcuts and About, shown as modals. */
export default function Panels() {
  const panel = usePanel((s) => s.panel);

  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && openPanel(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel]);

  if (!panel) return null;
  const title = { settings: "Settings", shortcuts: "Keyboard Shortcuts", about: "About Grove" }[panel];
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && openPanel(null)}>
      <div className={`dialog panel-dialog panel-${panel}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-dialog-head">
          <div className="dialog-title">{title}</div>
          <button className="icon-btn" onClick={() => openPanel(null)} aria-label="Close">
            ✕
          </button>
        </div>
        {panel === "settings" && <Settings />}
        {panel === "shortcuts" && <Shortcuts />}
        {panel === "about" && <About />}
      </div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div>
        <div className="setting-label">{label}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? "active" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Settings() {
  const s = useRepo();
  return (
    <div className="settings">
      <div className="settings-section">Appearance</div>
      <Row label="Theme">
        <Segmented<Theme>
          value={s.theme}
          options={[["system", "System"], ["light", "Light"], ["dark", "Dark"]]}
          onChange={s.setTheme}
        />
      </Row>
      <Row label="Diff font size">
        <input
          type="number"
          className="dialog-input small"
          min={10}
          max={24}
          value={s.fontSize}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (n >= 10 && n <= 24) s.setFontSize(n);
          }}
        />
      </Row>

      <div className="settings-section">Diffs</div>
      <Row label="Layout">
        <Segmented<DiffMode>
          value={s.diffMode}
          options={[["side-by-side", "Side by side"], ["inline", "Inline"]]}
          onChange={s.setDiffMode}
        />
      </Row>
      <Row label="Ignore whitespace changes" hint="Hide lines that differ only in leading or trailing spaces.">
        <input type="checkbox" checked={s.ignoreWhitespace} onChange={s.toggleWhitespace} />
      </Row>
      <Row label="Word wrap">
        <input type="checkbox" checked={s.wordWrap} onChange={s.toggleWordWrap} />
      </Row>

      {s.repo && <IdentitySettings root={s.repo.root} />}
    </div>
  );
}

function IdentitySettings({ root }: { root: string }) {
  const toast = useRepo((s) => s.toast);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [global, setGlobal] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    git.identity(root).then((id) => {
      setName(id.name);
      setEmail(id.email);
      setGlobal(!id.local);
      setLoaded(true);
    });
  }, [root]);

  if (!loaded) return null;
  return (
    <>
      <div className="settings-section">Git identity</div>
      <p className="setting-hint">The name and email recorded on your commits.</p>
      <Row label="Name">
        <input className="dialog-input" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
      </Row>
      <Row label="Email">
        <input className="dialog-input" value={email} onChange={(e) => setEmail(e.target.value)} spellCheck={false} />
      </Row>
      <Row label="Use for">
        <Segmented<"global" | "local">
          value={global ? "global" : "local"}
          options={[["global", "All repositories"], ["local", "This repository"]]}
          onChange={(v) => setGlobal(v === "global")}
        />
      </Row>
      <div className="dialog-buttons">
        <button
          className="btn primary"
          disabled={!name.trim() || !email.trim()}
          onClick={() =>
            git
              .setIdentity(root, name, email, global)
              .then(() => toast(global ? "Saved your git identity for all repositories." : "Saved your git identity for this repository."))
              .catch((e) => toast(errorMessage(e), "error"))
          }
        >
          Save Identity
        </button>
      </div>
    </>
  );
}

const SHORTCUTS: [string, string][] = [
  [`${mod}+O`, "Open repository"],
  [`${mod}+W`, "Close repository"],
  [`${mod}+,`, "Settings"],
  [`${mod}+Enter`, "Commit (in the message box)"],
  ["F5", "Refresh"],
  [`${mod}+Shift+H`, "Toggle History"],
  [`${mod}+Shift+B`, "Checkout branch"],
  [`${mod}+Shift+N`, "New branch"],
  [`${mod}+F`, "Find in diff"],
  ["F7 / Shift+F7", "Next / previous change"],
  ["Alt+Z", "Toggle word wrap"],
  [`${mod}+/`, "Keyboard shortcuts"],
];

function Shortcuts() {
  return (
    <table className="shortcuts">
      <tbody>
        {SHORTCUTS.map(([keys, what]) => (
          <tr key={keys}>
            <td>
              {keys.split(" / ").map((k, i) => (
                <span key={k}>
                  {i > 0 && " / "}
                  <kbd>{k}</kbd>
                </span>
              ))}
            </td>
            <td>{what}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function About() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (isTauri) getVersion().then(setVersion);
  }, []);
  return (
    <div className="about">
      <Logo size={48} />
      <div>
        <div className="about-name">Grove {version && <span className="muted">{version}</span>}</div>
        <p className="muted">A lightweight git GUI for Windows and macOS. Built with Tauri, React and Monaco; every operation runs your installed git.</p>
      </div>
    </div>
  );
}
