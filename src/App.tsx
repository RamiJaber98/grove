import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { git, isTauri } from "./api/git";
import { useRepo } from "./store/repo";
import { runCommand } from "./runCommand";
import { installShortcuts } from "./shortcuts";
import Welcome from "./components/Welcome";
import Workspace from "./components/Workspace";
import Toasts from "./components/Toasts";
import Dialog from "./components/Dialog";
import Panels from "./components/Panels";
// Credential prompts, progress & cancel.
import AskpassDialog from "./components/AskpassDialog";
import { FloatingProgress } from "./components/Progress";
import { installProgressListeners } from "./progress";
import { listenHere } from "./windowEvents";
import RebaseEditor from "./components/RebaseEditor";

declare global {
  interface Window {
    /** Set by the backend for extra windows (src-tauri/src/windows.rs): the repo to open, if any. */
    __GROVE_OPEN__?: string | null;
  }
}

export default function App() {
  const repo = useRepo((s) => s.repo);
  const theme = useRepo((s) => s.theme);

  useEffect(installShortcuts, []);
  // Credential prompts, progress & cancel: progress events for the busy indicator.
  useEffect(installProgressListeners, []);

  // Native menu clicks arrive as `menu` events carrying the item id.
  useEffect(() => {
    if (!isTauri) return;
    const unlisten = listenHere<string>("menu", (e) => runCommand(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // `grove <path>` opens that folder straight away. Extra windows get their
  // folder from the backend instead, so they don't reopen the launch path.
  useEffect(() => {
    if (!isTauri) return;
    if (getCurrentWebviewWindow().label !== "main") {
      const p = window.__GROVE_OPEN__;
      if (p) useRepo.getState().openRepo(p);
      return;
    }
    git.launchPath().then((p) => {
      if (p) useRepo.getState().openRepo(p);
    });
  }, []);

  // Keep the panel live: file-watcher events from the backend, plus a refresh
  // whenever the window regains focus (catches anything the watcher missed).
  useEffect(() => {
    if (!isTauri || !repo) return;
    const refresh = () => useRepo.getState().refresh();
    const unlistenChange = listenHere("repo-changed", refresh);
    const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) refresh();
    });
    return () => {
      unlistenChange.then((f) => f());
      unlistenFocus.then((f) => f());
    };
  }, [repo]);

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
      <Panels />
      <RebaseEditor />
      <Dialog />
      <AskpassDialog />
      <FloatingProgress />
      <Toasts />
    </>
  );
}
