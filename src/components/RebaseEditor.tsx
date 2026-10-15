import { useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { rebaseApi, type RebaseAction } from "../api/rebase";
import { withBusy } from "../actions";
import { ago } from "../refActions";
import {
  ACTIONS,
  check,
  closeRebase,
  defaultMessage,
  groups,
  isFold,
  messageFor,
  needsMessage,
  steps,
  useRebase,
  type Group,
  type RebaseSession,
  type Row,
} from "../rebase";
import { useRepo } from "../store/repo";

/** The interactive rebase editor, shown as a modal while a session is open. */
export default function RebaseEditor() {
  const session = useRebase((s) => s.session);
  const root = useRepo((s) => s.repo?.root);

  // A plan belongs to one repository; drop it if the user switches away.
  useEffect(() => {
    if (session && session.root !== root) closeRebase();
  }, [session, root]);

  if (!session) return null;
  return <Editor key={`${session.plan.base}:${session.plan.commits.length}`} session={session} />;
}

const KEY_ACTIONS = new Map(ACTIONS.map((a) => [a.key, a.action]));

function Editor({ session }: { session: RebaseSession }) {
  const { plan } = session;
  const [rows, setRows] = useState<Row[]>(() => plan.commits.map((commit) => ({ commit, action: "pick" })));
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [autostash, setAutostash] = useState(true);
  const [dragging, setDragging] = useState<number | null>(null);
  const drag = useRef<number | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const busy = useRepo((s) => s.busy);
  // Untracked files don't get in a rebase's way; tracked changes do.
  const dirty = useRepo((s) => s.staged.length > 0 || s.conflicts.length > 0 || s.changes.some((f) => f.kind !== "U"));
  const hasStaged = useRepo((s) => s.staged.length > 0);

  const gs = useMemo(() => groups(rows), [rows]);
  const result = check(plan, rows, edited);
  // Each group's message editor goes under its last row.
  const editorAfter = new Map<number, Group>();
  for (const g of gs) if (needsMessage(rows, g)) editorAfter.set(Math.max(g.head, ...g.folded), g);

  const rowEls = () => Array.from(list.current?.querySelectorAll<HTMLElement>(".rb-row") ?? []);
  const focusRow = (i: number) => requestAnimationFrame(() => rowEls()[i]?.focus());

  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length || from === to) return;
    setRows((rs) => {
      const next = rs.slice();
      const [r] = next.splice(from, 1);
      next.splice(to, 0, r);
      return next;
    });
  };
  const setAction = (i: number, action: RebaseAction) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, action } : r)));

  const onRowKey = (e: React.KeyboardEvent, i: number) => {
    if (e.target !== e.currentTarget) return; // typing in the select / textarea
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const to = i + (e.key === "ArrowUp" ? -1 : 1);
      move(i, to);
      focusRow(Math.max(0, Math.min(rows.length - 1, to)));
    } else if (!e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      focusRow(i + (e.key === "ArrowUp" ? -1 : 1));
    } else if (!e.altKey && !e.ctrlKey && !e.metaKey && KEY_ACTIONS.has(e.key.toLowerCase())) {
      e.preventDefault();
      setAction(i, KEY_ACTIONS.get(e.key.toLowerCase())!);
    }
  };

  // Pointer-based dragging: HTML5 drag-and-drop is swallowed by Tauri's
  // file-drop handling on Windows.
  const onDragMove = (e: React.PointerEvent) => {
    const from = drag.current;
    if (from === null) return;
    const els = rowEls();
    let to = els.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientY >= r.top && e.clientY < r.bottom;
    });
    if (to < 0 && els.length) {
      if (e.clientY < els[0].getBoundingClientRect().top) to = 0;
      else if (e.clientY >= els[els.length - 1].getBoundingClientRect().bottom) to = els.length - 1;
    }
    if (to < 0 || to === from) return;
    move(from, to);
    drag.current = to;
    setDragging(to);
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(null);
  };

  const start = async () => {
    if (result.warnings.length) {
      const ok = await ask(`${result.warnings.join("\n\n")}\n\nStart the rebase?`, {
        title: "Interactive Rebase",
        kind: "warning",
        okLabel: "Start Rebase",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
    }
    const todo = steps(rows, edited);
    let finished = false;
    await withBusy("Rebasing…", async (root) => {
      const out = await rebaseApi.start(root, plan.base, todo, dirty && autostash);
      finished = true;
      useRepo.getState().toast(out.message, out.state === "stopped" ? "error" : "info");
    });
    // On failure the editor stays open so nothing the user set up is lost.
    if (finished) closeRebase();
  };

  const blocked = result.errors.length > 0 || !result.changed || (dirty && !autostash) || !!busy;
  const count = plan.commits.length;

  return (
    <div className="dialog-backdrop">
      <div
        className="dialog rebase-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Interactive Rebase"
        onKeyDown={(e) => {
          const t = e.target as HTMLElement;
          if (e.key === "Escape" && t.tagName !== "TEXTAREA" && t.tagName !== "SELECT") closeRebase();
        }}
      >
        <div className="panel-dialog-head">
          <div className="dialog-title">
            Interactive Rebase <span className="muted">{session.branch}</span>
          </div>
          <button className="icon-btn" onClick={closeRebase} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="dialog-message">
          {plan.moves
            ? `Replaying ${count} commit${count === 1 ? "" : "s"} onto ${session.label}.`
            : `Editing the ${count} commit${count === 1 ? "" : "s"} after ${session.label}.`}{" "}
          Oldest at the top. Drag <span className="rb-grip-inline">⋮⋮</span> or press Alt+↑/↓ to reorder; press P, R, E, S, F or D on a row to set
          its action.
        </p>

        <ol className="rb-list" ref={list} onPointerMove={onDragMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
          {rows.map((r, i) => {
            const g = editorAfter.get(i);
            return (
              <li key={r.commit.hash} className="rb-item">
                <div
                  className={`rb-row rb-${r.action} ${dragging === i ? "dragging" : ""}`}
                  tabIndex={0}
                  onKeyDown={(e) => onRowKey(e, i)}
                  aria-label={`${r.action} ${r.commit.short} ${r.commit.subject}`}
                >
                  <span
                    className="rb-grip"
                    title="Drag to reorder"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      (e.currentTarget.closest(".rb-list") as HTMLElement).setPointerCapture(e.pointerId);
                      drag.current = i;
                      setDragging(i);
                    }}
                  >
                    ⋮⋮
                  </span>
                  <select
                    className="rb-action"
                    value={r.action}
                    onChange={(e) => setAction(i, e.target.value as RebaseAction)}
                    title={ACTIONS.find((a) => a.action === r.action)?.hint}
                  >
                    {ACTIONS.map((a) => (
                      <option key={a.action} value={a.action} title={a.hint}>
                        {a.action}
                      </option>
                    ))}
                  </select>
                  {isFold(r.action) && <span className="rb-fold" title="Combined into the commit above">↳</span>}
                  <span className="rb-hash">{r.commit.short}</span>
                  <span className="rb-subject" title={r.commit.message}>
                    {r.commit.subject}
                  </span>
                  {r.commit.pushed && (
                    <span className="rb-pushed" title="Already on a remote branch">
                      pushed
                    </span>
                  )}
                  <span className="rb-meta">
                    {r.commit.author} · {ago(r.commit.time)}
                  </span>
                  <span className="rb-move">
                    <button className="icon-btn" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="Move up" title="Move up (Alt+↑)">
                      ↑
                    </button>
                    <button
                      className="icon-btn"
                      disabled={i === rows.length - 1}
                      onClick={() => move(i, i + 1)}
                      aria-label="Move down"
                      title="Move down (Alt+↓)"
                    >
                      ↓
                    </button>
                  </span>
                </div>
                {g && <MessageEditor rows={rows} group={g} edited={edited} setEdited={setEdited} />}
              </li>
            );
          })}
        </ol>

        <div className="rb-preview">
          <div className="settings-section">
            Result · {gs.length} commit{gs.length === 1 ? "" : "s"} on {plan.moves ? session.label : plan.baseShort}
          </div>
          {gs.length === 0 && <div className="muted">No commits; the branch will point at {plan.baseShort}.</div>}
          {gs.map((g) => {
            const head = rows[g.head];
            const msg = needsMessage(rows, g) ? messageFor(rows, g, edited) : head.commit.message;
            return (
              <div key={head.commit.hash} className="rb-result">
                <span className="rb-hash">{head.commit.short}</span>
                <span className="rb-subject">{msg.split("\n")[0] || <em className="muted">(no message)</em>}</span>
                {g.folded.length > 0 && <span className="rb-tag">+{g.folded.length} combined</span>}
                {head.action === "reword" && <span className="rb-tag">new message</span>}
                {head.action === "edit" && <span className="rb-tag">stops to edit</span>}
              </div>
            );
          })}
        </div>

        {result.errors.map((m) => (
          <div key={m} className="dialog-error">
            {m}
          </div>
        ))}
        {result.warnings.map((m) => (
          <div key={m} className="rb-warning">
            {m}
          </div>
        ))}
        {!result.changed && <div className="setting-hint">Nothing changes yet: reorder commits or pick different actions.</div>}
        {dirty && (
          <label className="check rb-autostash">
            <input type="checkbox" checked={autostash} onChange={(e) => setAutostash(e.target.checked)} />
            You have uncommitted changes. Stash them during the rebase and restore them afterwards.
          </label>
        )}
        {/* git's --autostash restores changes without their staged state. */}
        {dirty && autostash && hasStaged && (
          <div className="setting-hint">Staged changes come back unstaged; stage them again after the rebase.</div>
        )}
        {dirty && !autostash && <div className="dialog-error">Commit or stash your changes first, or let Grove stash them.</div>}

        <div className="dialog-buttons">
          <button className="btn" onClick={closeRebase}>
            Cancel
          </button>
          <button className="btn primary" disabled={blocked} onClick={start}>
            Start Rebase
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageEditor({
  rows,
  group,
  edited,
  setEdited,
}: {
  rows: Row[];
  group: Group;
  edited: Record<string, string>;
  setEdited: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  const head = rows[group.head].commit;
  const value = messageFor(rows, group, edited);
  const custom = head.hash in edited && edited[head.hash] !== defaultMessage(rows, group);
  return (
    <div className="rb-message">
      <div className="rb-message-head">
        <span className="setting-hint">{group.hasSquash ? `Message for the combined commit (${head.short} + ${group.folded.length})` : `New message for ${head.short}`}</span>
        {custom && (
          <button
            className="link"
            onClick={() =>
              setEdited((e) => {
                const next = { ...e };
                delete next[head.hash];
                return next;
              })
            }
          >
            reset
          </button>
        )}
      </div>
      <textarea
        className="rb-textarea"
        value={value}
        spellCheck={false}
        rows={Math.min(8, Math.max(2, value.split("\n").length))}
        onChange={(e) => setEdited((ed) => ({ ...ed, [head.hash]: e.target.value }))}
        aria-label={`Message for ${head.short}`}
      />
    </div>
  );
}
