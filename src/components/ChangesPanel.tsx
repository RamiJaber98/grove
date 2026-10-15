import { useMemo, useRef, useState, type ReactNode } from "react";
import type { FileChange } from "../api/git";
import * as actions from "../actions";
import { fileMenu, primaryAction, stashMenu } from "../fileActions";
import {
  filesOf,
  isOpen,
  isSelected,
  listKey,
  selectAll,
  selectOnly,
  selectRange,
  setOpen,
  targetsFor,
  toggle,
  usePanelSelection,
} from "../panelSelection";
import { finishOperation } from "../refActions";
import { runCommand } from "../runCommand";
import { useRepo, type Group } from "../store/repo";
import ContextMenu, { openContextMenu, type MenuItem } from "./ContextMenu";
import { ArrowDown, ArrowUp, Check, Chevron, Discard, Minus, Plus, Spinner, Trash } from "./Icons";
import MoreMenu from "./MoreMenu";
import { markResolved } from "../conflictActions";
import { SubmoduleMark } from "./ExtraDiff";

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
  const busy = useRepo((s) => s.busy);
  const ahead = useRepo((s) => s.ahead);
  const behind = useRepo((s) => s.behind);
  const operation = useRepo((s) => s.operation);
  const { stage, unstage, unstageAll, discard } = useRepo.getState();

  const hasMessage = message.trim().length > 0;
  const canCommit = !busy && hasMessage && conflicts.length === 0 && staged.length + changes.length > 0;
  const commitTitle = conflicts.length
    ? "Resolve merge conflicts before committing"
    : staged.length + changes.length === 0
      ? "Nothing to commit"
      : !hasMessage
        ? "Enter a commit message"
        : staged.length
          ? "Commit staged changes (Ctrl+Enter)"
          : "Stage all changes and commit (Ctrl+Enter)";

  return (
    <aside className="panel" style={{ width }}>
      <div className="panel-toolbar">
        <span className="panel-title">Source Control</span>
        <button className="btn primary small" onClick={() => runCommand("commit")} disabled={!canCommit} title={commitTitle}>
          {busy === "Committing…" ? <Spinner /> : <Check size={14} />} Commit
        </button>
        <button
          className="btn small"
          onClick={() => runCommand("push")}
          disabled={!!busy}
          title={ahead ? `Push ${ahead} commit${ahead === 1 ? "" : "s"}` : "Push"}
        >
          {busy?.includes("ushing") ? <Spinner /> : <ArrowUp size={14} />} Push
          {ahead > 0 && <span className="count">{ahead}</span>}
        </button>
        <button
          className="btn small"
          onClick={() => runCommand("pull")}
          disabled={!!busy}
          title={behind ? `Pull ${behind} commit${behind === 1 ? "" : "s"}` : "Pull"}
        >
          {busy === "Pulling…" ? <Spinner /> : <ArrowDown size={14} />} Pull
          {behind > 0 && <span className="count">{behind}</span>}
        </button>
        <MoreMenu />
      </div>

      <div className="commit-box">
        <textarea
          placeholder="Commit message"
          value={message}
          rows={3}
          spellCheck
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canCommit) runCommand("commit");
          }}
        />
      </div>

      {operation && (
        <div className="op-banner" role="status">
          <div className="op-text">
            <strong>{operation[0].toUpperCase() + operation.slice(1)} in progress.</strong>{" "}
            {conflicts.length
              ? `Resolve ${conflicts.length} conflicted file${conflicts.length === 1 ? "" : "s"}, stage them, then continue.`
              : "Conflicts resolved. Continue to finish."}
          </div>
          <div className="op-buttons">
            <button className="btn small" onClick={() => finishOperation("abort")} disabled={!!busy}>
              Abort
            </button>
            <button
              className="btn small primary"
              onClick={() => finishOperation("continue")}
              disabled={!!busy || conflicts.length > 0}
              title={conflicts.length ? "Resolve and stage all conflicts first" : `Finish the ${operation}`}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      <FileTree>
        {conflicts.length > 0 && (
          <FileGroup
            group="conflicts"
            title="Merge Changes"
            files={conflicts}
            fileActions={(f) => [
              { title: "Mark as Resolved (Stage)", icon: <Plus />, run: () => markResolved(targetsFor("conflicts", f)) },
            ]}
          />
        )}
        <FileGroup
          group="staged"
          title="Staged"
          files={staged}
          emptyText="No staged changes"
          groupActions={[{ title: "Unstage All", icon: <Minus />, run: unstageAll }]}
          fileActions={(f) => [{ title: "Unstage", icon: <Minus />, run: () => unstage(targetsFor("staged", f)) }]}
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
            {
              title: f.kind === "U" ? "Delete File" : "Discard Changes",
              icon: <Discard />,
              run: () => discard(targetsFor("changes", f)),
            },
            { title: "Stage", icon: <Plus />, run: () => stage(targetsFor("changes", f)) },
          ]}
        />
        <Section id="stashed" title="Stashed" count={stashes.length}>
          {stashes.length === 0 ? (
            <div className="group-empty">No stashes</div>
          ) : (
            stashes.map((s) => (
              <FileGroup
                key={s.ref}
                group="stash"
                stashRef={s.ref}
                title={s.message}
                tooltip={`${s.ref}${s.branch ? ` on ${s.branch}` : ""}, ${new Date(s.time * 1000).toLocaleString()}`}
                files={s.files}
                nested
                menu={() => stashMenu(s)}
                groupActions={[
                  { title: "Drop Stash", icon: <Trash />, run: () => actions.dropStash(s.ref) },
                  { title: "Apply Stash (keep it)", icon: <Check />, run: () => actions.applyStash(false, s.ref) },
                  { title: "Pop Stash (apply and remove)", icon: <Discard />, run: () => actions.applyStash(true, s.ref) },
                ]}
              />
            ))
          )}
        </Section>
      </FileTree>
      <ContextMenu />
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
          // Rows are reached with the arrow keys; Tab leaves the list.
          tabIndex={-1}
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

const isMac = navigator.userAgent.includes("Mac");
const modKey = (e: { ctrlKey: boolean; metaKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey);

/** Every visible row (headers and files), in display order. */
const navItems = (tree: HTMLElement) => [...tree.querySelectorAll<HTMLElement>("[data-nav]")];

/** The header row of the section containing `el` (for a header: of its parent section). */
function parentHeader(el: HTMLElement) {
  const group = el.closest(".group");
  const section = el.dataset.nav === "header" ? group?.parentElement?.closest(".group") : group;
  return section?.querySelector<HTMLElement>(":scope > [data-nav]") ?? null;
}

function focusRow(el: HTMLElement | null | undefined, selectFile = true) {
  if (!el) return;
  el.focus();
  el.scrollIntoView({ block: "nearest" });
  if (selectFile && el.dataset.nav === "file") selectOnly(el.dataset.key!, el.dataset.path!);
}

/** Opens the context menu for a row; keyboard-opened menus (no pointer position) anchor to the row. */
function showMenu(e: React.MouseEvent<HTMLElement>, items: () => MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  const row = e.currentTarget;
  const r = row.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  row.focus();
  openContextMenu(inside ? e.clientX : r.left + 24, inside ? e.clientY : r.bottom, items(), row);
}

/**
 * The scrollable list of groups, as an ARIA tree. Rows use a roving focus:
 * the tree is a single Tab stop that hands focus to the last-focused row,
 * and the arrow keys move between rows.
 */
function FileTree({ children }: { children: ReactNode }) {
  const [inside, setInside] = useState(false);
  const last = useRef<{ nav?: string; key?: string; path?: string }>({});

  function findLast(tree: HTMLElement) {
    const items = navItems(tree);
    const l = last.current;
    return (
      items.find((el) => el.dataset.nav === l.nav && el.dataset.key === l.key && el.dataset.path === l.path) ??
      items.find((el) => el.getAttribute("aria-selected") === "true") ??
      items[0]
    );
  }

  /** After a row acts on itself (and so may vanish), keep focus near where it was. */
  async function keepFocus(tree: HTMLElement, index: number, action: unknown) {
    await action;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== tree) return;
      const items = navItems(tree);
      focusRow(items[Math.min(index, items.length - 1)]);
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const el = e.target as HTMLElement;
    const kind = el.dataset.nav;
    if (!kind) return;
    const tree = e.currentTarget;
    const items = navItems(tree);
    const i = items.indexOf(el);
    const key = el.dataset.key!;
    const isFile = kind === "file";
    const nested = el.dataset.nested === "true";
    const file = isFile ? filesOf(key).find((f) => f.path === el.dataset.path) : undefined;
    const group = (key.startsWith("stash:") ? "stash" : key) as Group;
    const s = useRepo.getState();
    let handled = true;

    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        const dir = e.key === "ArrowDown" ? 1 : -1;
        if (e.shiftKey && isFile) {
          // Extend within this list only; selections never span groups.
          const next = items[i + dir];
          if (next?.dataset.nav === "file" && next.dataset.key === key) {
            focusRow(next, false);
            selectRange(key, next.dataset.path!);
          }
        } else {
          focusRow(items[i + dir]);
        }
        break;
      }
      case "Home":
        focusRow(items[0]);
        break;
      case "End":
        focusRow(items[items.length - 1]);
        break;
      case "ArrowLeft":
        if (!isFile && isOpen(key, nested)) setOpen(key, false);
        else {
          const header = parentHeader(el);
          if (isFile && header) setOpen(header.dataset.key!, false);
          focusRow(header);
        }
        break;
      case "ArrowRight":
        if (!isFile && !isOpen(key, nested)) setOpen(key, true);
        else if (!isFile && items[i + 1] && parentHeader(items[i + 1]) === el) focusRow(items[i + 1]);
        break;
      case "Enter":
        if (!isFile) setOpen(key, !isOpen(key, nested));
        else if (file) s.select({ group, path: file.path, from: file.from, stashRef: el.dataset.stash || undefined });
        break;
      case " ":
        if (!isFile) setOpen(key, !isOpen(key, nested));
        else if (file && group !== "stash") keepFocus(tree, i, primaryAction(group, targetsFor(key, file)));
        break;
      case "Delete":
      case "Backspace":
        if (file && group === "changes") keepFocus(tree, i, s.discard(targetsFor(key, file)));
        else handled = false;
        break;
      case "a":
      case "A":
        if (file && modKey(e) && !e.shiftKey && !e.altKey) selectAll(key, file.path);
        else handled = false;
        break;
      case "Escape":
        if (file) selectOnly(key, file.path);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  return (
    <div
      className="groups"
      role="tree"
      aria-label="Changed files"
      aria-multiselectable="true"
      tabIndex={inside ? -1 : 0}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        setInside(true);
        const { nav, key, path } = (e.target as HTMLElement).dataset;
        if (nav) last.current = { nav, key, path };
        if (e.target === e.currentTarget) focusRow(findLast(e.currentTarget), false);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setInside(false);
      }}
    >
      {children}
    </div>
  );
}

function Section({
  id,
  title,
  tooltip,
  count,
  nested,
  actions,
  menu,
  children,
}: {
  /** Key for the expanded state; also how keyboard navigation finds the section. */
  id: string;
  title: string;
  tooltip?: string;
  count: number;
  nested?: boolean;
  actions?: Action[];
  /** Context menu for the header; defaults to the header's actions. */
  menu?: () => MenuItem[];
  children: ReactNode;
}) {
  const open = usePanelSelection((s) => s.open[id] ?? !nested);
  const items = menu ?? (actions && count > 0 ? () => actions.map((a) => ({ label: a.title, run: a.run })) : null);
  return (
    <div className={`group ${nested ? "nested" : ""}`}>
      <div
        className="group-header"
        role="treeitem"
        aria-level={nested ? 2 : 1}
        aria-expanded={open}
        aria-label={`${title}, ${count} file${count === 1 ? "" : "s"}`}
        tabIndex={-1}
        title={tooltip}
        data-nav="header"
        data-key={id}
        data-nested={nested ? "true" : "false"}
        onClick={() => setOpen(id, !open)}
        onContextMenu={items ? (e) => showMenu(e, items) : undefined}
      >
        <Chevron open={open} size={14} />
        <span className="group-title">{title}</span>
        {actions && count > 0 && <Actions actions={actions} />}
        <span className="badge">{count}</span>
      </div>
      {open && (
        <div className="group-body" role="group">
          {children}
        </div>
      )}
    </div>
  );
}

function FileGroup({
  group,
  title,
  tooltip,
  files,
  emptyText,
  stashRef,
  nested,
  groupActions,
  fileActions,
  menu,
}: {
  group: Group;
  title: string;
  tooltip?: string;
  files: FileChange[];
  emptyText?: string;
  stashRef?: string;
  nested?: boolean;
  groupActions?: Action[];
  /** Hover buttons; use `targetsFor` in `run` so they act on the whole selection. */
  fileActions?: (f: FileChange) => Action[];
  /** Context menu for the group header. */
  menu?: () => MenuItem[];
}) {
  const current = useRepo((s) => s.selection);
  const select = useRepo((s) => s.select);
  const key = listKey(group, stashRef);
  const selKey = usePanelSelection((s) => s.key);
  const selPaths = usePanelSelection((s) => s.paths);
  const selected = useMemo(() => new Set(selKey === key ? selPaths : []), [selKey, selPaths, key]);

  function onClick(e: React.MouseEvent, f: FileChange) {
    if (e.shiftKey) selectRange(key, f.path);
    else if (modKey(e)) toggle(key, f.path);
    else selectOnly(key, f.path);
    // The diff always follows the last clicked file.
    select({ group, path: f.path, from: f.from, stashRef });
  }

  function onContextMenu(e: React.MouseEvent<HTMLElement>, f: FileChange) {
    // Right-clicking outside the selection targets just that file; the diff stays put.
    if (!isSelected(key, f.path)) selectOnly(key, f.path);
    showMenu(e, () => fileMenu(group, targetsFor(key, f)));
  }
  const submodules = useRepo((s) => s.submodules);

  return (
    <Section
      id={key}
      title={title}
      tooltip={tooltip}
      count={files.length}
      nested={nested}
      actions={groupActions}
      menu={menu}
    >
      {files.length === 0 && emptyText ? <div className="group-empty">{emptyText}</div> : null}
      {files.map((f) => {
        const isCurrent = current?.group === group && current.path === f.path && current.stashRef === stashRef;
        const isSel = selected.has(f.path);
        const name = f.path.split("/").pop();
        const dir = f.path.split("/").slice(0, -1).join("/");
        return (
          <div
            key={f.path}
            className={`file ${isSel ? "selected" : ""} ${isCurrent ? "current" : ""} ${f.kind === "D" ? "deleted" : ""}`}
            title={f.from ? `${f.from} → ${f.path}` : f.path}
            role="treeitem"
            aria-level={nested ? 3 : 2}
            aria-selected={isSel}
            aria-current={isCurrent ? "true" : undefined}
            tabIndex={-1}
            data-nav="file"
            data-key={key}
            data-path={f.path}
            data-stash={stashRef}
            onClick={(e) => onClick(e, f)}
            onContextMenu={(e) => onContextMenu(e, f)}
          >
            {group !== "stash" && submodules.includes(f.path) && <SubmoduleMark />}
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

