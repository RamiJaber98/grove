/**
 * Interactive rebase: choosing a base, the editor's session state, and the
 * pure rules (grouping, validation, preview) the editor renders from.
 */
import { create } from "zustand";
import { errorMessage, git } from "./api/git";
import { rebaseApi, type PlanCommit, type RebaseAction, type RebasePlan, type RebaseStep } from "./api/rebase";
import { pick } from "./dialogs";
import { ago } from "./refActions";
import { useRepo } from "./store/repo";

export interface RebaseSession {
  root: string;
  branch: string;
  /** What the user picked, for the title: a branch name or short hash. */
  label: string;
  plan: RebasePlan;
}

export const useRebase = create<{ session: RebaseSession | null }>(() => ({ session: null }));
export const closeRebase = () => useRebase.setState({ session: null });

const toast = (text: string, kind?: "info" | "error") => useRepo.getState().toast(text, kind);

/** Picks a base: a recent commit (rebase what came after it) or another branch. */
async function pickBase(root: string, branch: string): Promise<{ base: string; label: string } | null> {
  const [log, branches] = await Promise.all([git.log(root, 0, 100, false), git.branches(root)]).catch((e) => {
    toast(errorMessage(e), "error");
    return [null, null] as const;
  });
  if (!log || !branches) return null;
  if (log.length < 2) {
    toast("There's only one commit; there's nothing after it to rebase.");
    return null;
  }
  // HEAD itself is skipped: nothing comes after it.
  const commits = log.slice(1).map((c, i) => ({
    label: `${c.short}  ${c.subject}`,
    detail: `edit the ${i + 1} newer commit${i === 0 ? "" : "s"} · ${c.author} · ${ago(c.time)}`,
    value: { base: c.hash, label: c.short },
  }));
  const others = branches
    .filter((b) => !b.current && b.name !== branch)
    .map((b) => ({
      label: `onto ${b.name}`,
      detail: `${b.remote ? "remote branch · " : ""}${b.hash} · ${b.subject}`,
      value: { base: b.name, label: b.name },
    }));
  return pick({
    title: `Interactive Rebase ${branch}`,
    placeholder: "Pick the commit to rebase from (its newer commits are edited), or a branch to rebase onto",
    items: [...commits, ...others],
  });
}

/**
 * Opens the editor. With `preset` (History › Rebase from here) the base is
 * already chosen; otherwise the user picks one.
 */
export async function openInteractiveRebase(preset?: { base: string; label: string }) {
  const s = useRepo.getState();
  const root = s.repo?.root;
  if (!root) return;
  if (s.operation) return toast(`A ${s.operation} is already in progress. Finish or abort it first.`);
  if (!s.branch) return toast("HEAD is detached. Check out a branch before rebasing.");
  const branch = s.branch;
  const target = preset ?? (await pickBase(root, branch));
  if (!target) return;
  try {
    const plan = await rebaseApi.plan(root, target.base);
    useRebase.setState({ session: { root, branch, label: target.label, plan } });
  } catch (e) {
    toast(errorMessage(e), "error");
  }
}

// ── Pure rules ───────────────────────────────────────────────────────────

export interface Row {
  commit: PlanCommit;
  action: RebaseAction;
}

/** A commit of the result: a kept commit plus the squash/fixup rows folded into it. */
export interface Group {
  head: number;
  /** Indexes of squash/fixup rows folded into the head. */
  folded: number[];
  hasSquash: boolean;
}

export const ACTIONS: { action: RebaseAction; key: string; hint: string }[] = [
  { action: "pick", key: "p", hint: "keep the commit" },
  { action: "reword", key: "r", hint: "keep it, change its message" },
  { action: "edit", key: "e", hint: "stop at it so you can amend it" },
  { action: "squash", key: "s", hint: "combine into the commit above, merging messages" },
  { action: "fixup", key: "f", hint: "combine into the commit above, keeping its message" },
  { action: "drop", key: "d", hint: "remove the commit" },
];

export const isFold = (a: RebaseAction) => a === "squash" || a === "fixup";

/** Mirrors how git reads the todo: drops are skipped, folds join the previous kept commit. */
export function groups(rows: Row[]): Group[] {
  const out: Group[] = [];
  rows.forEach((r, i) => {
    if (r.action === "drop") return;
    if (isFold(r.action)) {
      const g = out[out.length - 1];
      if (g) {
        g.folded.push(i);
        g.hasSquash ||= r.action === "squash";
      }
      return;
    }
    out.push({ head: i, folded: [], hasSquash: false });
  });
  return out;
}

export const needsMessage = (rows: Row[], g: Group) => rows[g.head].action === "reword" || g.hasSquash;

/** The message git would propose: the head's, plus every squashed one. */
export function defaultMessage(rows: Row[], g: Group) {
  if (!g.hasSquash) return rows[g.head].commit.message;
  return [g.head, ...g.folded.filter((i) => rows[i].action === "squash")]
    .map((i) => rows[i].commit.message.trim())
    .join("\n\n");
}

export function messageFor(rows: Row[], g: Group, edited: Record<string, string>) {
  return edited[rows[g.head].commit.hash] ?? defaultMessage(rows, g);
}

export interface Check {
  errors: string[];
  warnings: string[];
  /** False when starting would leave the branch exactly as it is. */
  changed: boolean;
}

export function check(plan: RebasePlan, rows: Row[], edited: Record<string, string>): Check {
  const errors: string[] = [];
  const warnings: string[] = [];
  const firstKept = rows.find((r) => r.action !== "drop");
  if (firstKept && isFold(firstKept.action)) {
    errors.push(`The first kept commit (${firstKept.commit.short}) can't be ${firstKept.action}: there's nothing above it to combine with.`);
  }
  const gs = groups(rows);
  for (const g of gs) {
    if (needsMessage(rows, g) && !messageFor(rows, g, edited).trim()) {
      errors.push(`Enter a message for ${rows[g.head].commit.short}.`);
    }
  }
  if (!firstKept) warnings.push(`Every commit is dropped: ${useRepo.getState().branch ?? "the branch"} will point at ${plan.baseShort}.`);

  const reordered = rows.some((r, i) => r.commit.hash !== plan.commits[i].hash);
  const changed = plan.moves || reordered || rows.some((r) => r.action !== "pick");
  // Rewriting starts at the first commit whose position or action changed.
  const firstTouched = plan.moves ? 0 : rows.findIndex((r, i) => r.action !== "pick" || r.commit.hash !== plan.commits[i].hash);
  const pushed = firstTouched < 0 ? [] : plan.commits.slice(firstTouched).filter((c) => c.pushed);
  if (changed && pushed.length) {
    warnings.push(
      `${pushed.length} of these commits ${pushed.length === 1 ? "is" : "are"} already pushed. Rewriting them means force pushing afterwards, which affects anyone who pulled them.`,
    );
  }
  return { errors, warnings, changed };
}

export function steps(rows: Row[], edited: Record<string, string>): RebaseStep[] {
  const messages = new Map<number, string>();
  for (const g of groups(rows)) if (needsMessage(rows, g)) messages.set(g.head, messageFor(rows, g, edited));
  return rows.map((r, i) => ({ hash: r.commit.hash, action: r.action, message: messages.get(i) ?? null }));
}
