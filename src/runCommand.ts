import { open } from "@tauri-apps/plugin-dialog";
import * as actions from "./actions";
import * as refs from "./refActions";
import type { RemoteOp } from "./api/git";
import { COMMANDS } from "./commands";
import { getActiveDiffEditor } from "./diffEditorHandle";
import { useRepo } from "./store/repo";

export async function pickAndOpenRepo() {
  const dir = await open({ directory: true, title: "Open Repository" });
  if (typeof dir === "string") await useRepo.getState().openRepo(dir);
}

const REMOTE_OPS = new Set<string>([
  "fetch",
  "fetch_prune",
  "fetch_all",
  "pull",
  "pull_rebase",
  "push",
  "push_force",
  "sync",
]);

/** Single entry point for native menu clicks, the ⋯ menu and panel buttons. */
export async function runCommand(id: string) {
  const s = useRepo.getState();
  if (REMOTE_OPS.has(id)) return actions.remote(id as RemoteOp);
  switch (id) {
    case "commit":
      return actions.commit();
    case "commit_amend":
      return actions.amend();
    case "undo_commit":
      return actions.undoLastCommit();
    case "stash":
      return actions.stash("tracked");
    case "stash_untracked":
      return actions.stash("include_untracked");
    case "stash_staged":
      return actions.stash("staged");
    case "stash_apply":
      return actions.applyStash(false);
    case "stash_pop":
      return actions.applyStash(true);
    case "stash_drop":
      return actions.dropStash();
    case "checkout_branch":
      return refs.checkoutBranch();
    case "new_branch":
      return refs.newBranch();
    case "rename_branch":
      return refs.renameBranch();
    case "delete_branch":
      return refs.deleteBranch();
    case "merge_branch":
      return refs.mergeBranch();
    case "rebase_branch":
      return refs.rebaseBranch();
    case "add_tag":
      return refs.createTag();
    case "delete_tag":
      return refs.deleteTag();
    case "push_tags":
      return refs.pushTags();
    case "manage_remotes":
      return refs.manageRemotes();
    case "add_remote":
      return refs.addRemote();
    case "remove_remote":
      return refs.removeRemote();
    case "reset_soft":
      return refs.resetTo("soft");
    case "reset_mixed":
      return refs.resetTo("mixed");
    case "reset_hard":
      return refs.resetTo("hard");
    case "clean_untracked":
      return refs.cleanUntracked();
    case "open_repo":
      return pickAndOpenRepo();
    case "close_repo":
      return s.closeRepo();
    case "refresh":
      return s.refresh();
    case "stage_all":
      // Only the Changes list: `git add -A` would also mark conflicts resolved.
      return s.stage(s.changes);
    case "unstage_all":
      return s.unstageAll();
    case "discard_all":
      return s.discard(s.changes);
    case "find": {
      const editor = getActiveDiffEditor()?.getModifiedEditor();
      if (!editor) return s.toast("Open a file's diff to search it.");
      editor.focus();
      return editor.trigger("grove", "actions.find", null);
    }
    case "next_change":
      return getActiveDiffEditor()?.goToDiff("next");
    case "prev_change":
      return getActiveDiffEditor()?.goToDiff("previous");
    case "diff_side_by_side":
      return s.setDiffMode("side-by-side");
    case "diff_inline":
      return s.setDiffMode("inline");
    case "toggle_whitespace":
      s.toggleWhitespace();
      return s.toast(`Ignore whitespace ${useRepo.getState().ignoreWhitespace ? "on" : "off"}`);
    case "toggle_word_wrap":
      s.toggleWordWrap();
      return s.toast(`Word wrap ${useRepo.getState().wordWrap ? "on" : "off"}`);
    case "theme_system":
      return s.setTheme("system");
    case "theme_light":
      return s.setTheme("light");
    case "theme_dark":
      return s.setTheme("dark");
    case "about":
      return s.toast("Grove 0.1.0 — a lightweight git GUI");
  }

  const cmd = COMMANDS[id];
  if (cmd?.phase) {
    s.toast(`${cmd.label} isn't wired up yet (planned for phase ${cmd.phase}).`);
  } else {
    s.toast(`Unknown command: ${id}`, "error");
  }
}
