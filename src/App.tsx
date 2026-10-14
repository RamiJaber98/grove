import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { git, isTauri } from "./api/git";
import { useRepo } from "./store/repo";
import { runCommand } from "./runCommand";
import Welcome from "./components/Welcome";
import Workspace from "./components/Workspace";
import Toasts from "./components/Toasts";

export default function App() {
  const repo = useRepo((s) => s.repo);
  const theme = useRepo((s) => s.theme);

  // Native menu clicks arrive as `menu` events carrying the item id.
  useEffect(() => {
    if (!isTauri) return;
    const unlisten = listen<string>("menu", (e) => runCommand(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // `grove <path>` opens that folder straight away.
  useEffect(() => {
    if (!isTauri) return;
    git.launchPath().then((p) => {
      if (p) useRepo.getState().openRepo(p);
    });
  }, []);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const title = repo ? `${repo.name} — Grove` : "Grove";
    document.title = title;
    if (isTauri) getCurrentWindow().setTitle(title);
  }, [repo]);

  return (
    <>
      {repo ? <Workspace /> : <Welcome />}
      <Toasts />
    </>
  );
}
