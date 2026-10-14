/**
 * Multi-step user actions: commit, amend, undo, and remote operations. Each
 * validates state, confirms anything risky, runs with a busy indicator, and
 * refreshes the panel afterwards.
 */
import { ask } from "@tauri-apps/plugin-dialog";
import { errorMessage, git, type RemoteOp } from "./api/git";
import { useRepo } from "./store/repo";

const subject = (message: string) => message.split("\n")[0];

/**
 * Runs `fn` while showing `label` as the busy state. Only one long-running
 * operation at a time; git would refuse overlapping index writes anyway.
 */
async function withBusy(label: string, fn: (root: string) => Promise<void>) {
  const s = useRepo.getState();
  if (!s.repo) return;
  if (s.busy) {
    s.toast(`Wait for "${s.busy}" to finish.`);
    return;
  }
  s.setBusy(label);
  try {
    await fn(s.repo.root);
  } catch (e) {
    s.toast(errorMessage(e), "error");
  } finally {
    s.setBusy(null);
    await useRepo.getState().refresh();
  }
}

/** True when HEAD is already on the remote, so rewriting it needs a force push. */
function headIsPublished() {
  const { upstream, ahead } = useRepo.getState();
  return upstream !== null && ahead === 0;
}

export async function commit() {
  const s = useRepo.getState();
  const message = s.commitMessage.trim();
  if (!message) return s.toast("Enter a commit message.");
  if (s.conflicts.length) return s.toast("Resolve the merge conflicts before committing.", "error");

  let stageFirst = false;
  if (s.staged.length === 0) {
    if (s.changes.length === 0) return s.toast("There are no changes to commit.");
    stageFirst = await ask("There are no staged changes. Stage all of your changes and commit them?", {
      title: "Commit",
      kind: "info",
      okLabel: "Stage All & Commit",
      cancelLabel: "Cancel",
    });
    if (!stageFirst) return;
  }

  await withBusy("Committing…", async (root) => {
    if (stageFirst) await git.stage(root, useRepo.getState().changes.map((f) => f.path));
    const hash = await git.commit(root, message, false);
    // Only clear the box if the user hasn't started typing a new message.
    if (useRepo.getState().commitMessage.trim() === message) useRepo.getState().setCommitMessage("");
    useRepo.getState().toast(`Committed ${hash}: ${subject(message)}`);
  });
}

export async function amend() {
  const s = useRepo.getState();
  if (!s.repo) return;
  const last = await git.lastCommitMessage(s.repo.root).catch(() => null);
  if (last === null) return s.toast("There's no commit to amend yet.");

  const typed = s.commitMessage.trim();
  let detail = typed
    ? `Its message will be replaced with the one you typed.`
    : `Its message stays the same.`;
  if (s.staged.length) detail += ` Your ${s.staged.length} staged file(s) will be added to it.`;
  if (headIsPublished()) detail += `\n\nThis commit is already pushed; you'll need to force push afterwards.`;

  const ok = await ask(`Amend "${subject(last)}"?\n\n${detail}`, {
    title: "Amend Last Commit",
    kind: "warning",
    okLabel: "Amend",
    cancelLabel: "Cancel",
  });
  if (!ok) return;

  await withBusy("Amending…", async (root) => {
    const hash = await git.commit(root, typed, true);
    if (typed) useRepo.getState().setCommitMessage("");
    useRepo.getState().toast(`Amended ${hash}`);
  });
}

export async function undoLastCommit() {
  const s = useRepo.getState();
  if (!s.repo) return;
  const last = await git.lastCommitMessage(s.repo.root).catch(() => null);
  if (last === null) return s.toast("There are no commits to undo.");

  let detail = "Its changes will stay staged so you can edit and recommit them.";
  if (headIsPublished()) detail += "\n\nThis commit is already pushed; undoing it locally won't remove it from the remote.";
  const ok = await ask(`Undo "${subject(last)}"?\n\n${detail}`, {
    title: "Undo Last Commit",
    kind: "warning",
    okLabel: "Undo Commit",
    cancelLabel: "Cancel",
  });
  if (!ok) return;

  await withBusy("Undoing commit…", async (root) => {
    const message = await git.undoLastCommit(root);
    // Put the message back so recommitting is one click.
    if (!useRepo.getState().commitMessage.trim()) useRepo.getState().setCommitMessage(message);
    useRepo.getState().toast(`Undid "${subject(message)}". Its changes are staged.`);
  });
}

const REMOTE_LABEL: Record<RemoteOp, string> = {
  fetch: "Fetching…",
  fetch_prune: "Fetching…",
  fetch_all: "Fetching…",
  pull: "Pulling…",
  pull_rebase: "Pulling…",
  push: "Pushing…",
  push_force: "Force pushing…",
  sync: "Syncing…",
};

export async function remote(op: RemoteOp) {
  if (op === "push_force") {
    const ok = await ask(
      "Force push overwrites the remote branch with your local one.\n\nGrove uses --force-with-lease, so it will refuse if someone else has pushed commits you haven't fetched.",
      { title: "Force Push", kind: "warning", okLabel: "Force Push", cancelLabel: "Cancel" },
    );
    if (!ok) return;
  }
  await withBusy(REMOTE_LABEL[op], async (root) => {
    useRepo.getState().toast(await git.remoteOp(root, op));
  });
}
