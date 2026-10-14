import { open } from "@tauri-apps/plugin-dialog";
import { COMMANDS } from "./commands";
import { useRepo } from "./store/repo";

export async function pickAndOpenRepo() {
  const dir = await open({ directory: true, title: "Open Repository" });
  if (typeof dir === "string") await useRepo.getState().openRepo(dir);
}

/** Single entry point for native menu clicks, the ⋯ menu and panel buttons. */
export async function runCommand(id: string) {
  const s = useRepo.getState();
  switch (id) {
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
