import { useState } from "react";
import type { FileChange } from "../api/git";
import { runCommand } from "../runCommand";
import { useRepo, type Group } from "../store/repo";
import { ArrowDown, ArrowUp, Check, Chevron } from "./Icons";
import MoreMenu from "./MoreMenu";

export default function ChangesPanel({ width }: { width: number }) {
  const staged = useRepo((s) => s.staged);
  const changes = useRepo((s) => s.changes);
  const stashes = useRepo((s) => s.stashes);
  const message = useRepo((s) => s.commitMessage);
  const setMessage = useRepo((s) => s.setCommitMessage);

  const canCommit = staged.length > 0 && message.trim().length > 0;

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
        <FileGroup group="staged" title="Staged" files={staged} emptyText="No staged changes" />
        <FileGroup group="changes" title="Changes" files={changes} emptyText="Working tree clean" />
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

function Section({
  title,
  count,
  nested,
  children,
}: {
  title: string;
  count: number;
  nested?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!nested);
  return (
    <div className={`group ${nested ? "nested" : ""}`}>
      <button className="group-header" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Chevron open={open} size={14} />
        <span className="group-title">{title}</span>
        <span className="badge">{count}</span>
      </button>
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
}: {
  group: Group;
  title: string;
  files: FileChange[];
  emptyText?: string;
  stashRef?: string;
  nested?: boolean;
}) {
  const selection = useRepo((s) => s.selection);
  const select = useRepo((s) => s.select);

  return (
    <Section title={title} count={files.length} nested={nested}>
      {files.length === 0 && emptyText ? <div className="group-empty">{emptyText}</div> : null}
      {files.map((f) => {
        const selected =
          selection?.group === group && selection.path === f.path && selection.stashRef === stashRef;
        const name = f.path.split("/").pop();
        const dir = f.path.split("/").slice(0, -1).join("/");
        return (
          <button
            key={f.path}
            className={`file ${selected ? "selected" : ""}`}
            onClick={() => select({ group, path: f.path, stashRef })}
            title={f.from ? `${f.from} → ${f.path}` : f.path}
          >
            <span className="file-name">{name}</span>
            <span className="file-dir">{dir}</span>
            <span className={`kind kind-${f.kind === "!" ? "conflict" : f.kind}`}>{f.kind}</span>
          </button>
        );
      })}
    </Section>
  );
}
