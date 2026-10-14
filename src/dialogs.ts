/**
 * In-app dialogs that the native dialog plugin doesn't offer: a text prompt
 * and a filterable picker (VS Code "quick pick" style). Each returns a
 * promise that resolves with the result, or null if cancelled.
 */
import { create } from "zustand";

export interface PickItem<T> {
  label: string;
  detail?: string;
  value: T;
}

interface InputRequest {
  kind: "input";
  id: number;
  title: string;
  message?: string;
  placeholder?: string;
  initial?: string;
  okLabel: string;
  allowEmpty: boolean;
  /** Returns an error message to block submission, or null. */
  validate?: (value: string) => string | null;
  resolve: (value: string | null) => void;
}

interface PickRequest {
  kind: "pick";
  id: number;
  title: string;
  placeholder?: string;
  items: PickItem<unknown>[];
  resolve: (value: unknown) => void;
}

export type DialogRequest = InputRequest | PickRequest;

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export const useDialog = create<{ current: DialogRequest | null }>(() => ({ current: null }));

let nextId = 0;

function show(request: DistributiveOmit<DialogRequest, "id">) {
  // Only one dialog at a time; a new one cancels the previous.
  useDialog.getState().current?.resolve(null);
  useDialog.setState({ current: { ...request, id: ++nextId } as DialogRequest });
}

export function closeDialog(result: unknown) {
  const current = useDialog.getState().current;
  useDialog.setState({ current: null });
  current?.resolve(result as never);
}

export function promptText(opts: {
  title: string;
  message?: string;
  placeholder?: string;
  initial?: string;
  okLabel?: string;
  allowEmpty?: boolean;
  validate?: (value: string) => string | null;
}): Promise<string | null> {
  return new Promise((resolve) =>
    show({ kind: "input", okLabel: "OK", allowEmpty: false, ...opts, resolve }),
  );
}

export function pick<T>(opts: { title: string; placeholder?: string; items: PickItem<T>[] }): Promise<T | null> {
  return new Promise((resolve) =>
    show({ kind: "pick", ...opts, resolve: resolve as (v: unknown) => void }),
  );
}

/** Larger app panels shown as modals (one at a time). */
export type Panel = "settings" | "shortcuts" | "about";
export const usePanel = create<{ panel: Panel | null }>(() => ({ panel: null }));
export const openPanel = (panel: Panel | null) => usePanel.setState({ panel });
