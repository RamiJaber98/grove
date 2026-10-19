import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * Listens only to events addressed to this window. A plain `listen()` would
 * also receive events meant for other Grove windows.
 */
export const listenHere = <T,>(event: string, handler: (e: { payload: T }) => void) =>
  getCurrentWebviewWindow().listen<T>(event, handler);
