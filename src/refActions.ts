/**
 * Branch, tag, remote and history flows behind the ⋯ menu, the Branch and
 * Repository menus, and the status-bar branch switcher.
 */
import { ask } from "@tauri-apps/plugin-dialog";
import { errorMessage, git, type Branch, type Commit, type LogEntry, type ResetMode } from "./api/git";
import { remote, withBusy } from "./actions";
import { pick, promptText, type PickItem } from "./dialogs";
import { useRepo } from "./store/repo";

const root = () => useRepo.getState().repo?.root;
const toast = (text: string, kind?: "info" | "error") => useRepo.getState().toast(text, kind);

function ago(unixSeconds: number) {
  const s = Date.now() / 1000 - unixSeconds;
  if (s < 60) return "just now";
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, "year"],
    [60 * 60 * 24 * 30, "month"],
    [60 * 60 * 24 * 7, "week"],
    [60 * 60 * 24, "day"],
    [60 * 60, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

async function loadBranches(): Promise<Branch[] | null> {
  const r = root();
  if (!r) return null;
  try {
    return await git.branches(r);
  } catch (e) {
    toast(errorMessage(e), "error");
    return null;
  }
}

function branchItem(b: Branch): PickItem<Branch> {
  return {
    label: b.current ? `● ${b.name}` : b.name,
    detail: `${b.hash} · ${b.subject} · ${ago(b.time)}`,
    value: b,
  };
}

/** Picks a local branch other than the current one. */
async function pickOtherLocal(title: string): Promise<Branch | null> {
  const all = await loadBranches();
  if (!all) return null;
  const others = all.filter((b) => !b.remote && !b.current);
  if (others.length === 0) {
    toast("There are no other local branches.");
    return null;
  }
  return pick({ title, placeholder: "Pick a branch", items: others.map(branchItem) });
}

/** Branch name prompt, validated by git's own rules as you type. */
async function promptBranchName(title: string, initial = ""): Promise<string | null> {
  const r = root();
  if (!r) return null;
  const existing = new Set((await loadBranches())?.filter((b) => !b.remote).map((b) => b.name));
  return promptText({
    title,
    placeholder: "Branch name",
    initial,
    okLabel: "Create",
    validate: (v) => {
      const name = v.trim();
      if (!name) return null;
      if (/\s/.test(name)) return "Branch names can't contain spaces.";
      if (name.startsWith("-")) return 'Branch names can\'t start with "-".';
      if (/\.\.|[~^:?*[\\]|@\{|\/$|\.lock$|^\.|\/\./.test(name)) return "That isn't a valid branch name.";
      if (existing.has(name) && name !== initial) return `A branch named "${name}" already exists.`;
      return null;
    },
  });
}

// ── Branches ────────────────────────────────────────────────────────────

const CREATE_NEW = Symbol("create");

export async function checkoutBranch() {
  const all = await loadBranches();
  if (!all) return;
  const localNames = new Set(all.filter((b) => !b.remote).map((b) => b.name));
  // Hide remote branches that already have a local branch of the same name.
  const remotes = all.filter((b) => b.remote && !localNames.has(b.name.slice(b.name.indexOf("/") + 1)));
  const items: PickItem<Branch | typeof CREATE_NEW>[] = [
    { label: "+ Create new branch…", value: CREATE_NEW },
    ...all.filter((b) => !b.remote).map(branchItem),
    ...remotes.map((b) => ({ ...branchItem(b), label: `${b.name}  (remote)` })),
  ];
  const choice = await pick({ title: "Checkout Branch", placeholder: "Pick a branch to switch to", items });
  if (choice === null) return;
  if (choice === CREATE_NEW) return newBranch();
  if (choice.current) return;
  await withBusy("Switching branch…", async (r) => {
    const name = await git.checkout(r, choice.name, choice.remote);
    toast(`Switched to ${name}.`);
  });
}

export async function newBranch() {
  const name = await promptBranchName("New Branch");
  if (!name) return;
  await withBusy("Creating branch…", async (r) => {
    await git.createBranch(r, name, null, true);
    toast(`Created and switched to ${name}.`);
  });
}

export async function renameBranch() {
  const current = useRepo.getState().branch;
  if (!current) return toast("HEAD is detached; there's no branch to rename.");
  const name = await promptBranchName(`Rename ${current}`, current);
  if (!name || name === current) return;
  await withBusy("Renaming branch…", async (r) => {
    await git.renameBranch(r, current, name);
    toast(`Renamed ${current} to ${name}.`);
  });
}

export async function deleteBranch() {
  const b = await pickOtherLocal("Delete Branch");
  if (!b) return;
  const ok = await ask(`Delete the branch "${b.name}"?`, {
    title: "Delete Branch",
    kind: "warning",
    okLabel: "Delete",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  const r = root();
  if (!r) return;
  try {
    await git.deleteBranch(r, b.name, false);
    toast(`Deleted ${b.name}.`);
  } catch (e) {
    // git refuses to delete unmerged branches; offer to force it.
    if (!errorMessage(e).includes("not fully merged")) return toast(errorMessage(e), "error");
    const force = await ask(
      `"${b.name}" has commits that aren't merged into any other branch. Deleting it will lose them.\n\nDelete anyway?`,
      { title: "Delete Unmerged Branch", kind: "warning", okLabel: "Delete Anyway", cancelLabel: "Cancel" },
    );
    if (!force) return;
    await withBusy("Deleting branch…", async (r2) => {
      await git.deleteBranch(r2, b.name, true);
      toast(`Deleted ${b.name}.`);
    });
  }
  await useRepo.getState().refresh();
}

export async function mergeBranch() {
  const current = useRepo.getState().branch ?? "HEAD";
  const b = await pickOtherLocal(`Merge Into ${current}`);
  if (!b) return;
  await withBusy("Merging…", async (r) => {
    try {
      toast(await git.merge(r, b.name));
    } catch (e) {
      // A conflicted merge isn't a failure to report as an error; the
      // banner and Merge Changes group take it from here.
      const s = await git.status(r);
      if (s.operation === "merge") toast(`Merge has conflicts in ${s.conflicts.length} file(s). Resolve them, stage them, then Continue.`);
      else throw e;
    }
  });
}

export async function rebaseBranch() {
  const current = useRepo.getState().branch ?? "HEAD";
  const b = await pickOtherLocal(`Rebase ${current} Onto`);
  if (!b) return;
  const ok = await ask(
    `Rebase ${current} onto ${b.name}?\n\nThis rewrites ${current}'s commits on top of ${b.name}. If ${current} is already pushed, you'll need to force push afterwards.`,
    { title: "Rebase", kind: "warning", okLabel: "Rebase", cancelLabel: "Cancel" },
  );
  if (!ok) return;
  await withBusy("Rebasing…", async (r) => {
    try {
      toast(await git.rebase(r, b.name));
    } catch (e) {
      const s = await git.status(r);
      if (s.operation === "rebase") toast("Rebase stopped on a conflict. Resolve it, stage the files, then Continue.");
      else throw e;
    }
  });
}

export async function finishOperation(action: "abort" | "continue") {
  const { operation } = useRepo.getState();
  if (!operation) return;
  if (action === "abort") {
    const ok = await ask(`Abort the ${operation}? Your branch goes back to how it was before it started.`, {
      title: `Abort ${operation}`,
      kind: "warning",
      okLabel: "Abort",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
  }
  await withBusy(action === "abort" ? "Aborting…" : "Continuing…", async (r) => {
    await git.operation(r, operation, action);
    if (action === "abort") return toast(`Aborted the ${operation}.`);
    // A rebase that reaches the next `edit` stops again but succeeds.
    const after = await git.status(r);
    toast(
      after.operation
        ? `The ${after.operation} stopped again. Make your changes, then Continue.`
        : `Finished the ${operation}.`,
    );
  });
}

// ── Tags ────────────────────────────────────────────────────────────────

export async function createTag() {
  const name = await promptText({
    title: "Create Tag",
    message: "Tags the current commit.",
    placeholder: "Tag name, e.g. v1.2.0",
    okLabel: "Next",
    validate: (v) => (/\s/.test(v.trim()) ? "Tag names can't contain spaces." : null),
  });
  if (!name) return;
  const message = await promptText({
    title: `Create Tag ${name}`,
    message: "Add a message to make an annotated tag, or leave it empty for a lightweight tag.",
    placeholder: "Message (optional)",
    okLabel: "Create Tag",
    allowEmpty: true,
  });
  if (message === null) return;
  await withBusy("Creating tag…", async (r) => {
    await git.createTag(r, name, message);
    toast(`Created tag ${name}.`);
  });
}

export async function deleteTag() {
  const r = root();
  if (!r) return;
  const tags = await git.tags(r).catch((e) => (toast(errorMessage(e), "error"), null));
  if (!tags) return;
  if (tags.length === 0) return toast("There are no tags.");
  const name = await pick({
    title: "Delete Tag",
    items: tags.map((t) => ({ label: t.name, detail: t.subject, value: t.name })),
  });
  if (!name) return;
  const ok = await ask(`Delete the local tag "${name}"?`, {
    title: "Delete Tag",
    kind: "warning",
    okLabel: "Delete",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  await withBusy("Deleting tag…", async (r2) => {
    await git.deleteTag(r2, name);
    toast(`Deleted tag ${name}.`);
  });
}

export const pushTags = () => remote("push_tags");

// ── Remotes ─────────────────────────────────────────────────────────────

export async function addRemote() {
  const r = root();
  if (!r) return;
  const existing = await git.remotes(r).catch(() => []);
  const taken = new Set(existing.map((x) => x.name));
  const name = await promptText({
    title: "Add Remote",
    placeholder: "Remote name",
    initial: taken.has("origin") ? "" : "origin",
    okLabel: "Next",
    validate: (v) =>
      taken.has(v.trim()) ? `A remote named "${v.trim()}" already exists.` : /\s/.test(v.trim()) ? "No spaces, please." : null,
  });
  if (!name) return;
  const url = await promptText({
    title: `Add Remote ${name}`,
    placeholder: "https://github.com/you/repo.git or git@github.com:you/repo.git",
    okLabel: "Add Remote",
  });
  if (!url) return;
  await withBusy("Adding remote…", async (r2) => {
    await git.addRemote(r2, name, url);
    toast(`Added remote ${name}.`);
  });
}

export async function removeRemote(name?: string) {
  const r = root();
  if (!r) return;
  if (!name) {
    const remotes = await git.remotes(r).catch(() => []);
    if (remotes.length === 0) return toast("This repository has no remotes.");
    name = (await pick({ title: "Remove Remote", items: remotes.map((x) => ({ label: x.name, detail: x.url, value: x.name })) })) ?? undefined;
    if (!name) return;
  }
  const ok = await ask(`Remove the remote "${name}"? Its remote-tracking branches are removed too.`, {
    title: "Remove Remote",
    kind: "warning",
    okLabel: "Remove",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  const target = name;
  await withBusy("Removing remote…", async (r2) => {
    await git.removeRemote(r2, target);
    toast(`Removed remote ${target}.`);
  });
}

const ADD_REMOTE = Symbol("add");

/** Repository › Remotes…: lists remotes, and adds or removes one. */
export async function manageRemotes() {
  const r = root();
  if (!r) return;
  const remotes = await git.remotes(r).catch((e) => (toast(errorMessage(e), "error"), null));
  if (!remotes) return;
  const choice = await pick<string | typeof ADD_REMOTE>({
    title: "Remotes",
    placeholder: remotes.length ? "Pick a remote to remove it, or add one" : "No remotes yet",
    items: [
      { label: "+ Add remote…", value: ADD_REMOTE },
      ...remotes.map((x) => ({ label: x.name, detail: x.url, value: x.name })),
    ],
  });
  if (choice === null) return;
  if (choice === ADD_REMOTE) return addRemote();
  return removeRemote(choice);
}

// ── Reset / clean ───────────────────────────────────────────────────────

const RESET_INFO: Record<ResetMode, { title: string; effect: string }> = {
  soft: { title: "Reset (Soft)", effect: "The undone commits' changes stay staged." },
  mixed: { title: "Reset (Mixed)", effect: "The undone commits' changes stay in your files, unstaged." },
  hard: {
    title: "Reset (Hard)",
    effect: "The undone commits AND all uncommitted changes are discarded. This can't be undone from Grove.",
  },
};

export async function resetTo(mode: ResetMode, preset?: Commit) {
  const r = root();
  if (!r) return;
  const info = RESET_INFO[mode];
  let target: Commit | null = preset ?? null;
  if (!target) {
    const commits = await git.recentCommits(r, 50).catch((e) => (toast(errorMessage(e), "error"), null));
    if (!commits) return;
    if (commits.length === 0) return toast("There are no commits yet.");
    target = await pick<Commit>({
    title: `${info.title}: move ${useRepo.getState().branch ?? "HEAD"} to…`,
    placeholder: "Pick the commit to reset to",
    items: commits.map((c, i) => ({
      label: `${c.short}  ${c.subject}`,
      detail: `${c.author} · ${ago(c.time)}${i === 0 ? " · current" : ""}`,
      value: c,
    })),
    });
  }
  if (!target) return;
  const chosen = target;
  const ok = await ask(`Reset to ${target.short} "${target.subject}"?\n\n${info.effect}`, {
    title: info.title,
    kind: "warning",
    okLabel: "Reset",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  await withBusy("Resetting…", async (r2) => {
    await git.reset(r2, chosen.hash, mode);
    toast(`Reset to ${chosen.short}.`);
  });
}

export async function cleanUntracked() {
  const untracked = useRepo.getState().changes.filter((f) => f.kind === "U");
  if (untracked.length === 0) return toast("There are no untracked files.");
  const ok = await ask(
    `Permanently delete ${untracked.length} untracked file(s) and any untracked folders? Ignored files are kept.\n\nThis can't be undone.`,
    { title: "Delete Untracked Files", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" },
  );
  if (!ok) return;
  await withBusy("Deleting untracked files…", async (r) => {
    const n = await git.clean(r);
    toast(`Deleted ${n} untracked item${n === 1 ? "" : "s"}.`);
  });
}

// ── History (commit-level actions) ──────────────────────────────────────

/** After a cherry-pick or revert stops on conflicts, explain instead of erroring. */
async function explainStop(r: string, e: unknown, what: string) {
  const s = await git.status(r);
  if (s.operation) toast(`${what} stopped on conflicts. Resolve and stage them, then Continue.`);
  else throw e;
}

export async function cherryPickCommit(c: { hash: string; short: string; subject: string }) {
  const ok = await ask(`Apply "${c.subject}" (${c.short}) on top of ${useRepo.getState().branch ?? "HEAD"}?`, {
    title: "Cherry-Pick",
    kind: "info",
    okLabel: "Cherry-Pick",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  await withBusy("Cherry-picking…", async (r) => {
    try {
      await git.cherryPick(r, c.hash);
      toast(`Cherry-picked ${c.short}.`);
    } catch (e) {
      await explainStop(r, e, "Cherry-pick");
    }
  });
}

export async function revertCommit(c: { hash: string; short: string; subject: string }) {
  const ok = await ask(`Create a new commit that undoes "${c.subject}" (${c.short})?`, {
    title: "Revert Commit",
    kind: "info",
    okLabel: "Revert",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  await withBusy("Reverting…", async (r) => {
    try {
      await git.revert(r, c.hash);
      toast(`Reverted ${c.short}.`);
    } catch (e) {
      await explainStop(r, e, "Revert");
    }
  });
}

export async function checkoutCommit(c: { hash: string; short: string }) {
  const ok = await ask(
    `Check out ${c.short} without a branch ("detached HEAD")?\n\nNew commits made there won't belong to any branch unless you create one.`,
    { title: "Checkout Commit", kind: "warning", okLabel: "Checkout", cancelLabel: "Cancel" },
  );
  if (!ok) return;
  await withBusy("Checking out…", async (r) => {
    await git.checkoutDetached(r, c.hash);
    toast(`Checked out ${c.short}.`);
  });
}

export async function branchAt(c: { hash: string; short: string }) {
  const name = await promptBranchName(`New Branch at ${c.short}`);
  if (!name) return;
  await withBusy("Creating branch…", async (r) => {
    await git.createBranch(r, name, c.hash, true);
    toast(`Created ${name} at ${c.short} and switched to it.`);
  });
}

export async function tagAt(c: { hash: string; short: string }) {
  const name = await promptText({
    title: `Create Tag at ${c.short}`,
    placeholder: "Tag name, e.g. v1.2.0",
    okLabel: "Next",
    validate: (v) => (/\s/.test(v.trim()) ? "Tag names can't contain spaces." : null),
  });
  if (!name) return;
  const message = await promptText({
    title: `Create Tag ${name}`,
    message: "Add a message to make an annotated tag, or leave it empty for a lightweight tag.",
    placeholder: "Message (optional)",
    okLabel: "Create Tag",
    allowEmpty: true,
  });
  if (message === null) return;
  await withBusy("Creating tag…", async (r) => {
    await git.createTag(r, name, message, c.hash);
    toast(`Created tag ${name} at ${c.short}.`);
  });
}

/** ⋯ › Cherry-Pick…: choose a commit from any branch. */
export async function pickAndCherryPick() {
  const r = root();
  if (!r) return;
  const entries = await git.log(r, 0, 200, true).catch((e) => (toast(errorMessage(e), "error"), null));
  if (!entries) return;
  const choice = await pick<LogEntry>({
    title: "Cherry-Pick",
    placeholder: "Pick a commit from any branch",
    items: entries.map((c) => ({ label: `${c.short}  ${c.subject}`, detail: `${c.author} · ${ago(c.time)}${c.refs.length ? ` · ${c.refs.join(", ")}` : ""}`, value: c })),
  });
  if (choice) await cherryPickCommit(choice);
}

/** ⋯ › Revert Commit…: choose a commit on the current branch. */
export async function pickAndRevert() {
  const r = root();
  if (!r) return;
  const entries = await git.log(r, 0, 200, false).catch((e) => (toast(errorMessage(e), "error"), null));
  if (!entries) return;
  if (entries.length === 0) return toast("There are no commits yet.");
  const choice = await pick<LogEntry>({
    title: "Revert Commit",
    placeholder: "Pick a commit to undo",
    items: entries.map((c) => ({ label: `${c.short}  ${c.subject}`, detail: `${c.author} · ${ago(c.time)}`, value: c })),
  });
  if (choice) await revertCommit(choice);
}

export { ago };
