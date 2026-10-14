/** Backend calls for File History and Blame (src-tauri/src/git/file_log.rs, blame.rs). */
import { invoke } from "@tauri-apps/api/core";

export interface FileLogEntry {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  time: number;
  subject: string;
  /** The file's path in this commit (differs from today's path before a rename). */
  path: string;
  /** The parent's path when this commit renamed or copied the file. */
  from?: string | null;
  /** Status letter in this commit; empty for merges. */
  kind: string;
}

export interface BlameCommit {
  hash: string;
  short: string;
  author: string;
  time: number;
  summary: string;
  path: string;
  uncommitted: boolean;
}

export interface BlameHunk {
  /** 1-based first line. */
  start: number;
  count: number;
  hash: string;
}

export interface Blame {
  text: string;
  binary: boolean;
  tooLarge: boolean;
  hunks: BlameHunk[];
  commits: Record<string, BlameCommit>;
}

export const fileHistoryApi = {
  fileLog: (root: string, path: string, skip: number, limit: number) =>
    invoke<FileLogEntry[]>("file_log", { root, path, skip, limit }),
  /** `rev` null blames the working tree; otherwise "HEAD" or a commit hash. */
  blame: (root: string, path: string, rev: string | null) => invoke<Blame>("blame", { root, path, rev }),
};
