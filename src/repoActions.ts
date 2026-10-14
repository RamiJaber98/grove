/** File-menu flows: clone, init, and hand-offs to the OS. */
import { open } from "@tauri-apps/plugin-dialog";
import { errorMessage, git } from "./api/git";
import { promptText } from "./dialogs";
import { useRepo } from "./store/repo";

const state = () => useRepo.getState();

/** Like withBusy, but works with no repository open (clone/init start there). */
async function busy(label: string, fn: () => Promise<void>) {
  if (state().busy) return state().toast(`Wait for "${state().busy}" to finish.`);
  state().setBusy(label);
  try {
    await fn();
  } catch (e) {
    state().toast(errorMessage(e), "error");
  } finally {
    state().setBusy(null);
  }
}

export async function cloneRepo() {
  const url = await promptText({
    title: "Clone Repository",
    placeholder: "https://github.com/owner/repo.git",
    okLabel: "Next",
  });
  if (!url) return;
  const parent = await open({ directory: true, title: "Clone into which folder?" });
  if (typeof parent !== "string") return;
  await busy("Cloning…", async () => {
    const path = await git.cloneRepo(url, parent);
    await state().openRepo(path);
    state().toast(`Cloned into ${path}.`);
  });
}

export async function initRepo() {
  const dir = await open({ directory: true, title: "Initialize a repository in which folder?" });
  if (typeof dir !== "string") return;
  await busy("Initializing…", async () => {
    await git.initRepo(dir);
    await state().openRepo(dir);
    state().toast("Initialized an empty repository.");
  });
}

function withRoot(fn: (root: string) => Promise<void>) {
  const root = state().repo?.root;
  if (!root) return state().toast("Open a repository first.");
  return fn(root).catch((e) => state().toast(errorMessage(e), "error"));
}

export const openRepoFolder = () => withRoot((root) => git.openFolder(root));
export const openTerminal = () => withRoot((root) => git.openTerminal(root));
export const editGitignore = () => withRoot((root) => git.openRepoFile(root, ".gitignore", true));
