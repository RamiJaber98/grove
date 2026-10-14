import { useState, type ReactNode } from "react";
import type { FileChange } from "../api/git";
import { runCommand } from "../runCommand";
import { useRepo, type Group } from "../store/repo";
import { ArrowDown, ArrowUp, Check, Chevron, Discard, Minus, Plus } from "./Icons";
import MoreMenu from "./MoreMenu";

interface Action {
  title: string;
  icon: ReactNode;
  run: () => void;
}

export default function ChangesPanel({ width }: { width: number }) {
  const staged = useRepo((s) => s.staged);
  const changes = useRepo((s) => s.changes);
  const conflicts = useRepo((s) => s.conflicts);
  const stashes = useRepo((s) => s.stashes);
  const message = useRepo((s) => s.commitMessage);
  const setMessage = useRepo((s) => s.setCommitMessage);
  const { stage, unstage, unstageAll, discard } = useRepo.getState();

  const canCommit = staged.length > 0 && conflicts.length === 0 && message.trim().length > 0;

  return (
    <aside className="panel" style={{ width }}>
      <div className="panel-toolbar">
        <span className="panel-title">Source Control</span>
        <button
          className="btn primary small"
          onClick={() => runCommand("commit")}
          disabled={!canCommit}
          title={canCommit ? "Commit staged changes (Ctrl+Enter)" : "Stage changes and enter a message to commit"}
        >
          <Check size={14} /> Commit
        </button>
        <button className="btn small" onClick={() => runCommand("push")} title="Push">
          <ArrowUp size={14} /> Push
        </button>
        <button className="btn small" onClick={() => runCommand("pull")} title="Pull">
          <ArrowDown size={14} /> Pull
        </button>
        <MoreMenu />
      </div>

      <div className="commit-box">
        <textarea
          placeholder="Commit message"
          value={message}
          rows={3}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canCommit) runCommand("commit");
          }}
        />
      </div>

      <div className="groups">
        {conflicts.length > 0 && (
          <FileGroup
            group="conflicts"
            title="Merge Changes"
            files={conflicts}
            fileActions={(f) => [{ title: "Mark as Resolved (Stage)", icon: <Plus />, run: () => stage([f]) }]}
          />
        )}
        <FileGroup
          group="staged"
          title="Staged"
          files={staged}
          emptyText="No staged changes"
          groupActions={[{ title: "Unstage All", icon: <Minus />, run: unstageAll }]}
          fileActions={(f) => [{ title: "Unstage", icon: <Minus />, run: () => unstage([f]) }]}
        />
        <FileGroup
          group="changes"
          title="Changes"
          files={changes}
          emptyText="No changes"
          groupActions={[
            { title: "Discard All Changes", icon: <Discard />, run: () => discard(changes) },
            { title: "Stage All Changes", icon: <Plus />, run: () => stage(changes) },
          ]}
          fileActions={(f) => [
            { title: f.kind === "U" ? "Delete File" : "Discard Changes", icon: <Discard />, run: () => discard([f]) },
            { title: "Stage", icon: <Plus />, run: () => stage([f]) },
          ]}
        />
        <Section title="Stashed" count={stashes.length}>
          {stashes.length === 0 ? (
            <div className="group-empty">No stashes</div>
          ) : (
            stashes.map((s) => (
              <FileGroup
                key={s.ref}
                group="stash"
                stashRef={s.ref}
                title={`${s.ref}: ${s.message}`}
                files={s.files}
                nested
              />
            ))
          )}
        </Section>
      </div>
    </aside>
  );
}

function Actions({ actions }: { actions: Action[] }) {
  return (
    <span className="row-actions">
      {actions.map((a) => (
        <button
          key={a.title}
          className="row-action"
          title={a.title}
          aria-label={a.title}
          onClick={(e) => {
            e.stopPropagation();
            a.run();
          }}
        >
          {a.icon}
        </button>
      ))}
    </span>
  );
}

/** Keyboard + mouse activation for the non-<button> rows (they contain buttons). */
function activate(fn: () => void) {
  return {
    role: "button",
    tabIndex: 0,
    onClick: fn,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        fn();
      }
    },
  };
}

function Section({
  title,
  count,
  nested,
  actions,
  children,
}: {
  title: string;
  count: number;
  nested?: boolean;
  actions?: Action[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!nested);
  return (
    <div className={`group ${nested ? "nested" : ""}`}>
      <div className="group-header" aria-expanded={open} {...activate(() => setOpen(!open))}>
        <Chevron open={open} size={14} />
        <span className="group-title">{title}</span>
        {actions && count > 0 && <Actions actions={actions} />}
        <span className="badge">{count}</span>
      </div>
      {open && <div className="group-body">{children}</div>}
    </div>
  );
}

function FileGroup({
  group,
  title,
  files,
  emptyText,
  stashRef,
  nested,
  groupActions,
  fileActions,
}: {
  group: Group;
  title: string;
  files: FileChange[];
  emptyText?: string;
  stashRef?: string;
  nested?: boolean;
  groupActions?: Action[];
  fileActions?: (f: FileChange) => Action[];
}) {
  const selection = useRepo((s) => s.selection);
  const select = useRepo((s) => s.select);

  return (
    <Section title={title} count={files.length} nested={nested} actions={groupActions}>
      {files.length === 0 && emptyText ? <div className="group-empty">{emptyText}</div> : null}
      {files.map((f) => {
        const selected =
          selection?.group === group && selection.path === f.path && selection.stashRef === stashRef;
        const name = f.path.split("/").pop();
        const dir = f.path.split("/").slice(0, -1).join("/");
        return (
          <div
            key={f.path}
            className={`file ${selected ? "selected" : ""} ${f.kind === "D" ? "deleted" : ""}`}
            title={f.from ? `${f.from} → ${f.path}` : f.path}
            {...activate(() => select({ group, path: f.path, stashRef }))}
          >
            <span className="file-name">{name}</span>
            <span className="file-dir">{dir}</span>
            {fileActions && <Actions actions={fileActions(f)} />}
            <span className={`kind kind-${f.kind === "!" ? "conflict" : f.kind}`}>{f.kind}</span>
          </div>
        );
      })}
    </Section>
  );
}
