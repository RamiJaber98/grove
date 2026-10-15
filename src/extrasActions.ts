/**
 * Flows for the less common commands: remote branches, worktrees,
 * submodules, Git LFS and extra windows. Reached through runCommand.
 */
import { ask, open } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";
import { errorMessage, git, isTauri, type Branch } from "./api/git";
import { extras, type LfsInfo, type Submodule, type Worktree } from "./api/extras";
import { withBusy } from "./actions";
import { pick, promptText, type PickItem } from "./dialogs";
import { useRepo } from "./store/repo";

const state = () => useRepo.getState();
const toast = (text: string, kind?: "info" | "error") => state().toast(text, kind);

/** Per-repo facts the menus depend on; reloaded whenever the repo changes. */
export const useExtras = create<{ lfs: LfsInfo | null }>(() => ({ lfs: null }));

useRepo.subscribe((s, prev) => {
  if (s.repo?.root === prev.repo?.root) return;
  useExtras.setState({ lfs: null });
  const root = s.repo?.root;
  if (!root || !isTauri) return;
  extras
    .lfsInfo(root)
    .then((lfs) => state().repo?.root === root && useExtras.setState({ lfs }))
    .catch(() => {});
});

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Size of the real file if `text` is a Git LFS pointer, else null. */
export function lfsPointerSize(text: string): number | null {
  if (text.length > 1024 || !text.startsWith("version https://git-lfs.github.com/spec/")) return null;
  const m = /^size (\d+)$/m.exec(text);
  return m ? Number(m[1]) : null;
}

/** Joins a folder chosen in a native dialog with a name, keeping its separator style. */
function joinPath(dir: string, name: string) {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

async function loadBranches(): Promise<Branch[] | null> {
  const root = state().repo?.root;
  if (!root) return null;
  return git.branches(root).catch((e) => (toast(errorMessage(e), "error"), null));
}

// ── Windows ─────────────────────────────────────────────────────────────

export function newWindow(path?: string) {
  return extras.newWindow(path).catch((e) => toast(errorMessage(e), "error"));
}

// ── Remote branches ─────────────────────────────────────────────────────

export async function deleteRemoteBranch() {
  const all = await loadBranches();
  if (!all) return;
  const remote = all.filter((b) => b.remote);
  if (remote.length === 0) return toast("There are no remote branches. Fetch first?");
  const b = await pick({
    title: "Delete Remote Branch",
    placeholder: "Pick a branch to delete on its remote",
    items: remote.map((b) => ({ label: b.name, detail: `${b.hash} · ${b.subject}`, value: b })),
  });
  if (!b) return;
  const slash = b.name.indexOf("/");
  const ok = await ask(
    `Delete "${b.name.slice(slash + 1)}" on the remote "${b.name.slice(0, slash)}"?\n\nThis removes it for everyone who uses that remote. Your local branches aren't touched.`,
    { title: "Delete Remote Branch", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" },
  );
  if (!ok) return;
  await withBusy("Deleting remote branch…", async (r) => toast(await extras.deleteRemoteBranch(r, b.name)));
}

export async function publishBranch() {
  const { repo, branch } = state();
  if (!repo) return;
  if (!branch) return toast("HEAD is detached. Check out a branch to publish.");
  const remotes = await git.remotes(repo.root).catch((e) => (toast(errorMessage(e), "error"), null));
  if (!remotes) return;
  if (remotes.length === 0) return toast("This repository has no remotes. Add one first.");
  const remote = await pick({
    title: `Publish ${branch} To`,
    placeholder: "Pick a remote; the branch will track it",
    items: remotes.map((r) => ({ label: r.name, detail: r.url, value: r.name })),
  });
  if (!remote) return;
  await withBusy("Publishing…", async (r) => toast(await extras.publishBranch(r, remote)));
}

export async function setUpstream() {
  const { branch, upstream } = state();
  if (!branch) return toast("HEAD is detached. Check out a branch first.");
  const all = await loadBranches();
  if (!all) return;
  const remote = all.filter((b) => b.remote);
  if (remote.length === 0) return toast("There are no remote branches. Fetch or publish first.");
  // The same-named branch is the usual choice, so list it first.
  const score = (b: Branch) => (b.name.endsWith(`/${branch}`) ? 0 : 1);
  const choice = await pick({
    title: `Set Upstream of ${branch}`,
    placeholder: upstream ? `Currently tracking ${upstream}` : "Pick the remote branch to track",
    items: [...remote].sort((a, b) => score(a) - score(b)).map((b) => ({
      label: b.name === upstream ? `● ${b.name}` : b.name,
      detail: `${b.hash} · ${b.subject}`,
      value: b.name,
    })),
  });
  if (!choice || choice === upstream) return;
  await withBusy("Setting upstream…", async (r) => toast(await extras.setUpstream(r, choice)));
}

// ── Worktrees ───────────────────────────────────────────────────────────

const ADD = Symbol("add");

function worktreeLabel(w: Worktree) {
  const name = w.branch ?? (w.bare ? "(bare)" : `detached at ${w.head?.slice(0, 7) ?? "?"}`);
  const flags = [w.current && "this window", w.main && "main", w.locked && "locked", w.prunable && "missing"].filter(Boolean);
  return flags.length ? `${name}  (${flags.join(", ")})` : name;
}

export async function manageWorktrees() {
  const root = state().repo?.root;
  if (!root) return toast("Open a repository first.");
  const list = await extras.worktrees(root).catch((e) => (toast(errorMessage(e), "error"), null));
  if (!list) return;
  const choice = await pick<Worktree | typeof ADD>({
    title: "Worktrees",
    placeholder: "Pick a worktree to open or remove it, or add one",
    items: [
      { label: "+ Add worktree…", value: ADD },
      ...list.map((w) => ({ label: worktreeLabel(w), detail: w.path, value: w })),
    ],
  });
  if (choice === null) return;
  if (choice === ADD) return addWorktree();
  if (choice.bare) return toast("That's the bare repository; it has no working tree to open.");

  type Act = "window" | "here" | "remove";
  const items: PickItem<Act>[] = [{ label: "Open in New Window", value: "window" }];
  if (!choice.current) items.push({ label: "Open in This Window", value: "here" });
  if (!choice.main && !choice.current) items.push({ label: "Remove Worktree…", detail: "deletes its folder", value: "remove" });
  const act = await pick({ title: worktreeLabel(choice), placeholder: choice.path, items });
  if (act === "window") return newWindow(choice.path);
  if (act === "here") return state().openRepo(choice.path);
  if (act === "remove") return removeWorktree(choice);
}

const NEW_BRANCH = Symbol("new");

export async function addWorktree() {
  const repo = state().repo;
  if (!repo) return;
  const all = await loadBranches();
  if (!all) return;
  const choice = await pick<Branch | typeof NEW_BRANCH>({
    title: "Add Worktree",
    placeholder: "Pick the branch to check out in the new worktree",
    items: [
      { label: "+ New branch from HEAD…", value: NEW_BRANCH },
      ...all.filter((b) => !b.remote && !b.current).map((b) => ({ label: b.name, detail: `${b.hash} · ${b.subject}`, value: b })),
    ],
  });
  if (choice === null) return;
  let branch: string;
  const create = choice === NEW_BRANCH;
  if (choice === NEW_BRANCH) {
    const name = await promptText({
      title: "Add Worktree: New Branch",
      placeholder: "Branch name",
      okLabel: "Next",
      validate: (v) => (/\s/.test(v.trim()) ? "Branch names can't contain spaces." : v.trim().startsWith("-") ? 'Branch names can\'t start with "-".' : null),
    });
    if (!name) return;
    branch = name.trim();
  } else {
    branch = choice.name;
  }
  const parent = await open({ directory: true, title: "Create the worktree inside which folder?" });
  if (typeof parent !== "string") return;
  const path = joinPath(parent, `${repo.name}-${branch.replace(/[\\/]/g, "-")}`);
  let added = false;
  await withBusy("Adding worktree…", async (r) => {
    await extras.addWorktree(r, path, branch, create);
    added = true;
  });
  if (!added) return;
  const openIt = await ask(`Created a worktree for ${branch} at:\n${path}\n\nOpen it in a new window?`, {
    title: "Worktree Added",
    kind: "info",
    okLabel: "Open",
    cancelLabel: "Not Now",
  });
  if (openIt) await newWindow(path);
}

export async function removeWorktree(w: Worktree) {
  const ok = await ask(`Remove the worktree at\n${w.path}?\n\nIts folder is deleted. The branch${w.branch ? ` "${w.branch}"` : ""} is kept.`, {
    title: "Remove Worktree",
    kind: "warning",
    okLabel: "Remove",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  const root = state().repo?.root;
  if (!root) return;
  try {
    await extras.removeWorktree(root, w.path, false);
    toast("Removed the worktree.");
  } catch (e) {
    // git refuses when the worktree has changes; offer to force it.
    const msg = errorMessage(e);
    if (!/modified or untracked|--force|locked/.test(msg)) return toast(msg, "error");
    const force = await ask(`${msg}\n\nRemove it anyway? Its uncommitted changes will be lost.`, {
      title: "Remove Worktree",
      kind: "warning",
      okLabel: "Remove Anyway",
      cancelLabel: "Cancel",
    });
    if (!force) return;
    await withBusy("Removing worktree…", async (r) => {
      await extras.removeWorktree(r, w.path, true);
      toast("Removed the worktree.");
    });
  }
}

// ── Submodules ──────────────────────────────────────────────────────────

const SUB_STATE: Record<string, string> = {
  " ": "up to date",
  "-": "not initialized",
  "+": "checked out at a different commit",
  U: "merge conflict",
};

export async function manageSubmodules() {
  const root = state().repo?.root;
  if (!root) return toast("Open a repository first.");
  const list = await extras.submodules(root).catch((e) => (toast(errorMessage(e), "error"), null));
  if (!list) return;
  if (list.length === 0) return toast("This repository has no submodules.");
  const sub = await pick<Submodule>({
    title: "Submodules",
    items: list.map((s) => ({ label: s.path, detail: `${s.hash.slice(0, 7)} · ${SUB_STATE[s.state] ?? s.state}`, value: s })),
  });
  if (!sub) return;
  const act = await pick({
    title: sub.path,
    items: [
      { label: "Update Submodule", detail: "check out the recorded commit (init if needed)", value: "update" as const },
      ...(sub.state === "-" ? [] : [{ label: "Open in New Window", value: "window" as const }]),
    ],
  });
  if (act === "update") return updateSubmodule(sub.path);
  if (act === "window") return openSubmodule(sub.path);
}

export function updateSubmodule(path: string) {
  return withBusy("Updating submodule…", async (r) => {
    await extras.updateSubmodule(r, path);
    toast(`Updated ${path}.`);
  });
}

export function openSubmodule(path: string) {
  const root = state().repo?.root;
  if (root) return newWindow(`${root}/${path}`);
}

// ── LFS ─────────────────────────────────────────────────────────────────

export async function fetchLfs() {
  const lfs = useExtras.getState().lfs;
  if (lfs && !lfs.used) return toast("This repository doesn't use Git LFS.");
  if (lfs && !lfs.installed) return toast("Git LFS isn't installed. Install it from https://git-lfs.com.", "error");
  await withBusy("Fetching LFS objects…", async (r) => toast(await extras.lfsPull(r)));
}

// ── Dispatch ────────────────────────────────────────────────────────────

const HANDLERS: Record<string, () => unknown> = {
  new_window: () => newWindow(),
  delete_remote_branch: deleteRemoteBranch,
  publish_branch: publishBranch,
  set_upstream: setUpstream,
  worktrees: manageWorktrees,
  submodules: manageSubmodules,
  lfs_fetch: fetchLfs,
};

/** Runs `id` if it's one of the extras; returns false otherwise. */
export function runExtraCommand(id: string): boolean {
  const handler = HANDLERS[id];
  if (!handler) return false;
  void handler();
  return true;
}
