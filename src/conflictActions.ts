/**
 * User actions of the merge conflict editor: saving a resolution, taking a
 * whole side, and marking a file resolved. Kept apart from the editor so the
 * Changes panel can use them without loading Monaco.
 */
import { ask } from "@tauri-apps/plugin-dialog";
import { git, type FileChange, type Resolution } from "./api/git";
import { withBusy } from "./actions";
import { parseConflicts, splitLines } from "./conflicts";
import { useRepo } from "./store/repo";

const fileName = (path: string) => path.split("/").pop() ?? path;

/** Asks before staging a file that still has conflict markers. */
async function confirmUnresolved(path: string, remaining: number): Promise<boolean> {
  return ask(
    `"${fileName(path)}" still contains ${remaining} conflict${remaining === 1 ? "" : "s"} (<<<<<<< … >>>>>>> markers).\n\nMark it as resolved anyway? The markers will be committed as-is.`,
    { title: "Unresolved Conflicts", kind: "warning", okLabel: "Mark Resolved", cancelLabel: "Cancel" },
  );
}

/**
 * Writes the editor's text to disk; with `stage`, also marks the file
 * resolved (after a warning if markers remain). Returns true if it saved.
 */
export async function saveResolution(path: string, content: string, stage: boolean): Promise<boolean> {
  const remaining = parseConflicts(splitLines(content)).length;
  if (stage && remaining > 0 && !(await confirmUnresolved(path, remaining))) return false;
  let saved = false;
  await withBusy(stage ? "Marking resolved…" : "Saving…", async (root) => {
    await git.saveConflict(root, path, content, stage);
    saved = true;
    if (stage) useRepo.getState().toast(`Resolved ${fileName(path)}.`);
  });
  return saved;
}

/** Takes one side for the whole file (binary, delete/modify) and stages it. */
export async function resolveWhole(path: string, resolution: Resolution, label: string) {
  if (resolution === "delete") {
    const ok = await ask(`Delete "${fileName(path)}" and mark the conflict resolved?`, {
      title: "Delete File",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
  }
  await withBusy("Resolving…", async (root) => {
    await git.resolveConflict(root, path, resolution);
    useRepo.getState().toast(`Resolved ${fileName(path)}: ${label}.`);
  });
}

/** The Merge Changes "+" button: stage, but warn first if markers remain. */
export async function markResolved(file: FileChange) {
  const s = useRepo.getState();
  if (!s.repo) return;
  const conflict = await git.conflictFile(s.repo.root, file.path).catch(() => null);
  const w = conflict?.working;
  const remaining = w && w.exists && !w.binary && !w.tooLarge ? parseConflicts(splitLines(w.text)).length : 0;
  if (remaining > 0 && !(await confirmUnresolved(file.path, remaining))) return;
  await s.stage([file]);
}
