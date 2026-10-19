/**
 * Progress of the running network operation (clone/fetch/pull/push), fed by
 * backend events. Non-null only while a cancellable operation is running.
 */
import { create } from "zustand";
import { isTauri, type GitProgress } from "./api/git";
import { listenHere } from "./windowEvents";

export const useProgress = create<{ progress: GitProgress | null }>(() => ({ progress: null }));

/** Subscribes to the backend's progress events; returns the unsubscribe. */
export function installProgressListeners(): () => void {
  if (!isTauri) return () => {};
  const subs = [
    listenHere<GitProgress>("git-progress", (e) => useProgress.setState({ progress: e.payload })),
    listenHere("git-progress-end", () => useProgress.setState({ progress: null })),
  ];
  return () => subs.forEach((s) => s.then((f) => f()));
}
