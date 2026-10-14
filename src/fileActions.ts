/**
 * What the Source Control panel's context menu (and its keyboard keys) can
 * do with files: hand-offs to the OS, clipboard, .gitignore, conflict
 * sides, and stash entries. Menu contents are built here per group so the
 * panel component stays about layout.
 */
import { ask } from "@tauri-apps/plugin-dialog";
import * as actions from "./actions";
import { files as api, type Side } from "./api/files";
import { errorMessage, git, type FileChange, type StashEntry } from "./api/git";
import type { MenuItem } from "./components/ContextMenu";
import { promptText } from "./dialogs";
import { useRepo, type Group } from "./store/repo";

const state = () => useRepo.getState();
const isWindows = navigator.userAgent.includes("Windows");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Opening dozens of windows at once is never what anyone meant. */
const MAX_OPEN = 20;

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = state().repo?.root;
  if (!root) return;
  try {
    await fn(root);
  } catch (e) {
    state().toast(errorMessage(e), "error");
  }
}

function tooMany(files: FileChange[]) {
  if (files.length <= MAX_OPEN) return false;
  state().toast(`Select at most ${MAX_OPEN} files to open at once.`);
  return true;
}

export const openFiles = (files: FileChange[]) =>
  !tooMany(files) &&
  withRoot(async (root) => {
    for (const f of files) await git.openRepoFile(root, f.path, false);
  });

export const openInEditor = (files: FileChange[]) =>
  !tooMany(files) &&
  withRoot(async (root) => {
    const usedCode = await api.openInEditor(root, files.map((f) => f.path));
    if (!usedCode) state().toast("VS Code's `code` command wasn't found, so the default app was used.");
  });

export const reveal = (file: FileChange) => withRoot((root) => api.revealRepoFile(root, file.path));

export function copyPaths(files: FileChange[], relative: boolean) {
  const root = state().repo?.root ?? "";
  const text = files
    .map((f) => {
      const p = relative ? f.path : `${root}/${f.path}`;
      return isWindows ? p.replace(/\//g, "\\") : p;
    })
    .join("\n");
  navigator.clipboard.writeText(text).then(
    () => state().toast(files.length === 1 ? `Copied ${text}` : `Copied ${plural(files.length, "path")}.`),
    (e) => state().toast(errorMessage(e), "error"),
  );
}

/** Escapes gitignore's glob characters so a file name matches only itself. */
function literal(path: string) {
  return path.replace(/[\\*?[\]]/g, "\\$&").replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
}

/** Patterns are anchored with a leading "/" so they match exactly that path. */
export const ignorePath = (f: FileChange) => `/${literal(f.path)}`;
const extOf = (path: string) => /\.([^./]+)$/.exec(path.split("/").pop()!.replace(/^\.+/, ""))?.[1] ?? null;
const dirOf = (path: string) => path.split("/").slice(0, -1).join("/");

export function addToGitignore(patterns: string[], files: FileChange[]) {
  return withRoot(async (root) => {
    const added = await api.gitignoreAdd(root, patterns);
    const what = patterns.length === 1 ? patterns[0] : plural(patterns.length, "pattern");
    let msg = added ? `Added ${what} to .gitignore.` : `.gitignore already has ${what}.`;
    // .gitignore only affects untracked files; say so instead of looking broken.
    if (files.some((f) => f.kind !== "U")) msg += " Files git already tracks stay tracked.";
    state().toast(msg);
    await state().refresh();
  });
}

/**
 * Asks other features (the file history view) to show `path`'s history.
 * Listeners call `preventDefault()` to claim it; unclaimed means no
 * history view is available.
 */
export function showFileHistory(path: string) {
  const ev = new CustomEvent("grove:file-history", { detail: path, cancelable: true });
  if (window.dispatchEvent(ev)) state().toast("File history isn't available in this build.");
}

export async function takeSide(files: FileChange[], side: Side) {
  const which = side === "ours" ? "your version (ours)" : "the incoming version (theirs)";
  const what = files.length === 1 ? `"${files[0].path}"` : plural(files.length, "conflicted file");
  const ok = await ask(`Resolve ${what} by taking ${which}?\n\nThe other side's changes to ${files.length === 1 ? "it" : "them"} will be lost.`, {
    title: side === "ours" ? "Accept Ours" : "Accept Theirs",
    kind: "warning",
    okLabel: side === "ours" ? "Accept Ours" : "Accept Theirs",
    cancelLabel: "Cancel",
  });
  if (!ok) return;
  await actions.withBusy("Resolving…", async (root) => {
    await api.takeSide(root, files.map((f) => f.path), side);
    state().toast(`Resolved ${what} with ${side === "ours" ? "ours" : "theirs"}.`);
  });
}

export async function branchFromStash(stash: StashEntry) {
  const name = await promptText({
    title: "Create Branch from Stash",
    message: `Creates the branch at the commit ${stash.ref} was made on, switches to it and applies the stash there (dropping it if that succeeds).`,
    placeholder: "Branch name",
    okLabel: "Create",
    validate: (v) => (/\s/.test(v.trim()) ? "Branch names can't contain spaces." : null),
  });
  if (!name) return;
  await actions.withBusy("Creating branch…", async (root) => {
    await api.stashBranch(root, name.trim(), stash.ref);
    state().toast(`Switched to new branch "${name.trim()}" with ${stash.ref} applied.`);
  });
}

/** Stage / unstage / mark resolved: what Space does in each group. */
export function primaryAction(group: Group, files: FileChange[]) {
  const s = state();
  if (group === "changes" || group === "conflicts") return s.stage(files);
  if (group === "staged") return s.unstage(files);
  return Promise.resolve();
}

/** Context menu for `files` (the selection, or the one right-clicked file). */
export function fileMenu(group: Group, files: FileChange[]): MenuItem[] {
  const s = state();
  const one = files.length === 1 ? files[0] : null;
  const n = files.length > 1 ? ` (${files.length})` : "";
  const present = files.filter((f) => f.kind !== "D");
  const open: MenuItem[] = [
    { label: `Open File${n}`, run: () => openFiles(present), disabled: present.length === 0 },
    ...(group === "stash"
      ? []
      : [{ label: `Open in VS Code${n}`, run: () => openInEditor(present), disabled: present.length === 0 }]),
  ];
  const copy: MenuItem[] = [
    { label: one ? "Copy Path" : `Copy Paths${n}`, run: () => copyPaths(files, false) },
    { label: one ? "Copy Relative Path" : `Copy Relative Paths${n}`, run: () => copyPaths(files, true) },
  ];
  const revealItem: MenuItem[] = one
    ? [{ label: isWindows ? "Reveal in File Explorer" : "Reveal in Finder", run: () => reveal(one) }]
    : [];
  const history: MenuItem[] = one && one.kind !== "U" ? [{ label: "View File History", run: () => showFileHistory(one.path) }] : [];

  switch (group) {
    case "changes": {
      const untracked = files.every((f) => f.kind === "U");
      const exts = [...new Set(files.map((f) => extOf(f.path)))];
      const dirs = [...new Set(files.map((f) => dirOf(f.path)))];
      const ignore: MenuItem[] = [
        { label: `Add to .gitignore${n}`, run: () => addToGitignore(files.map(ignorePath), files) },
      ];
      if (exts.length === 1 && exts[0]) {
        const pattern = `*.${literal(exts[0])}`;
        ignore.push({ label: `Add ${pattern} to .gitignore`, run: () => addToGitignore([pattern], files) });
      }
      if (dirs.length === 1 && dirs[0]) {
        const pattern = `/${literal(dirs[0])}/`;
        ignore.push({ label: `Add ${dirs[0]}/ to .gitignore`, run: () => addToGitignore([pattern], files) });
      }
      return [
        { label: `Stage${n}`, run: () => s.stage(files) },
        untracked
          ? { label: one ? "Delete File" : `Delete Files${n}`, run: () => s.discard(files), danger: true }
          : { label: `Discard Changes${n}`, run: () => s.discard(files), danger: true },
        "separator",
        ...open,
        ...revealItem,
        "separator",
        ...copy,
        "separator",
        ...ignore,
        "separator",
        ...history,
      ];
    }
    case "staged":
      return [
        { label: `Unstage${n}`, run: () => s.unstage(files) },
        "separator",
        ...open,
        ...revealItem,
        "separator",
        ...copy,
        "separator",
        ...history,
      ];
    case "conflicts":
      return [
        { label: `Mark as Resolved (Stage)${n}`, run: () => s.stage(files) },
        { label: `Accept Ours${n}`, run: () => takeSide(files, "ours") },
        { label: `Accept Theirs${n}`, run: () => takeSide(files, "theirs") },
        "separator",
        ...open,
        ...revealItem,
        "separator",
        ...copy,
      ];
    case "stash":
      return [...open, "separator", ...copy];
  }
}

/** Context menu for a stash entry's header row. */
export function stashMenu(stash: StashEntry): MenuItem[] {
  return [
    { label: "Apply Stash", run: () => actions.applyStash(false, stash.ref) },
    { label: "Pop Stash", run: () => actions.applyStash(true, stash.ref) },
    { label: "Create Branch from Stash…", run: () => branchFromStash(stash) },
    "separator",
    { label: "Drop Stash", run: () => actions.dropStash(stash.ref), danger: true },
  ];
}
