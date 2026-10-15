import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChange, StashEntry, Status } from "../api/git";
import { followSelection, useRepo } from "./repo";

const file = (path: string, kind: FileChange["kind"] = "M", from?: string): FileChange => ({ path, kind, from });

function status(parts: Partial<Status> = {}): Status {
  return {
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    hasCommits: true,
    staged: [],
    changes: [],
    conflicts: [],
    operation: null,
    submodules: [],
    ...parts,
  };
}

const stash = (ref: string, ...paths: string[]): StashEntry => ({
  ref,
  message: ref,
  branch: "main",
  time: 0,
  files: paths.map((p) => file(p)),
});

describe("followSelection", () => {
  it("keeps nothing selected", () => {
    expect(followSelection(null, status(), [])).toBeNull();
  });

  it("follows a file from Changes to Staged after staging", () => {
    const sel = followSelection({ group: "changes", path: "a.ts" }, status({ staged: [file("a.ts")] }), []);
    expect(sel).toEqual({ group: "staged", path: "a.ts" });
  });

  it("follows a file from Staged to Changes after unstaging", () => {
    const sel = followSelection({ group: "staged", path: "a.ts" }, status({ changes: [file("a.ts")] }), []);
    expect(sel).toEqual({ group: "changes", path: "a.ts" });
  });

  it("stays in the current group when the file is in both (partially staged)", () => {
    const both = status({ staged: [file("a.ts")], changes: [file("a.ts")] });
    expect(followSelection({ group: "changes", path: "a.ts" }, both, [])).toEqual({ group: "changes", path: "a.ts" });
    expect(followSelection({ group: "staged", path: "a.ts" }, both, [])).toEqual({ group: "staged", path: "a.ts" });
  });

  it("follows a file into Conflicts", () => {
    const sel = followSelection({ group: "changes", path: "a.ts" }, status({ conflicts: [file("a.ts", "!")] }), []);
    expect(sel).toEqual({ group: "conflicts", path: "a.ts" });
  });

  it("picks up the rename source from the new status", () => {
    const sel = followSelection(
      { group: "changes", path: "new.ts" },
      status({ staged: [file("new.ts", "R", "old.ts")] }),
      [],
    );
    expect(sel).toEqual({ group: "staged", path: "new.ts", from: "old.ts" });
  });

  it("clears the selection when the file is gone", () => {
    expect(followSelection({ group: "staged", path: "a.ts" }, status({ changes: [file("b.ts")] }), [])).toBeNull();
  });

  describe("stash selections", () => {
    const sel = { group: "stash" as const, path: "a.ts", stashRef: "stash@{1}" };

    it("keeps a file that is still in the same stash", () => {
      const stashes = [stash("stash@{0}", "x.ts"), stash("stash@{1}", "a.ts")];
      expect(followSelection(sel, status(), stashes)).toBe(sel);
    });

    it("clears it when the stash is gone", () => {
      expect(followSelection(sel, status(), [stash("stash@{0}", "a.ts")])).toBeNull();
    });

    it("clears it when the stash no longer has the file", () => {
      expect(followSelection(sel, status(), [stash("stash@{1}", "b.ts")])).toBeNull();
    });

    it("does not jump to a working-tree file of the same name", () => {
      expect(followSelection(sel, status({ changes: [file("a.ts")] }), [])).toBeNull();
    });
  });
});

describe("refresh", () => {
  const initial = useRepo.getState();
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    useRepo.setState({ ...initial, repo: { root: "/repo", name: "repo" } });
  });
  afterEach(() => {
    useRepo.setState(initial, true);
  });

  /** Makes `status` calls wait until released, and counts them. */
  function holdStatus() {
    const pending: (() => void)[] = [];
    let statusCalls = 0;
    invokeMock.mockImplementation((cmd: string): Promise<never> => {
      if (cmd === "status") {
        statusCalls++;
        return new Promise((resolve) =>
          pending.push(() => resolve(status({ changes: [file("a.ts")] }) as never)),
        );
      }
      if (cmd === "stash_list") return Promise.resolve([] as never);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    return {
      calls: () => statusCalls,
      async releaseAll() {
        // Each release lets the loop continue and possibly start another run.
        for (let i = 0; i < 10 && pending.length; i++) {
          pending.shift()!();
          await new Promise((r) => setTimeout(r, 0));
        }
      },
    };
  }

  it("loads status into the store", async () => {
    const held = holdStatus();
    const done = useRepo.getState().refresh();
    await held.releaseAll();
    await done;
    expect(useRepo.getState().changes).toEqual([file("a.ts")]);
    expect(useRepo.getState().statusVersion).toBe(initial.statusVersion + 1);
  });

  it("coalesces requests made while a refresh is running into one more run", async () => {
    const held = holdStatus();
    const s = useRepo.getState();
    const first = s.refresh();
    const second = s.refresh();
    const third = s.refresh();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(held.calls()).toBe(1);

    await held.releaseAll();
    await first;
    expect(held.calls()).toBe(2);
    expect(useRepo.getState().statusVersion).toBe(initial.statusVersion + 2);
  });

  it("starts a fresh run once the previous one finished", async () => {
    const held = holdStatus();
    const first = useRepo.getState().refresh();
    await held.releaseAll();
    await first;
    const second = useRepo.getState().refresh();
    expect(second).not.toBe(first);
    await held.releaseAll();
    await second;
    expect(held.calls()).toBe(2);
  });

  it("reports a failed refresh as an error toast", async () => {
    invokeMock.mockRejectedValue({ message: "not a git repository" });
    await useRepo.getState().refresh();
    expect(useRepo.getState().toasts.map((t) => [t.text, t.kind])).toEqual([["not a git repository", "error"]]);
  });

  it("does nothing without an open repository", async () => {
    useRepo.setState({ repo: null });
    await useRepo.getState().refresh();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("toasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useRepo.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dismisses info toasts after 3.5 s", () => {
    useRepo.getState().toast("Saved");
    expect(useRepo.getState().toasts).toMatchObject([{ text: "Saved", kind: "info" }]);
    vi.advanceTimersByTime(3499);
    expect(useRepo.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useRepo.getState().toasts).toEqual([]);
  });

  it("keeps error toasts for 8 s", () => {
    useRepo.getState().toast("Push failed", "error");
    vi.advanceTimersByTime(7999);
    expect(useRepo.getState().toasts).toMatchObject([{ text: "Push failed", kind: "error" }]);
    vi.advanceTimersByTime(1);
    expect(useRepo.getState().toasts).toEqual([]);
  });

  it("stacks toasts and expires each on its own schedule", () => {
    const s = useRepo.getState();
    s.toast("one");
    vi.advanceTimersByTime(1000);
    s.toast("two");
    s.toast("bad", "error");
    const ids = useRepo.getState().toasts.map((t) => t.id);
    expect(new Set(ids).size).toBe(3);
    vi.advanceTimersByTime(2500);
    expect(useRepo.getState().toasts.map((t) => t.text)).toEqual(["two", "bad"]);
    vi.advanceTimersByTime(1000);
    expect(useRepo.getState().toasts.map((t) => t.text)).toEqual(["bad"]);
    vi.advanceTimersByTime(10_000);
    expect(useRepo.getState().toasts).toEqual([]);
  });

  it("can be dismissed early, and the timer then is a no-op", () => {
    const s = useRepo.getState();
    s.toast("one");
    s.toast("two");
    const [first] = useRepo.getState().toasts;
    s.dismissToast(first.id);
    expect(useRepo.getState().toasts.map((t) => t.text)).toEqual(["two"]);
    vi.advanceTimersByTime(3500);
    expect(useRepo.getState().toasts).toEqual([]);
  });
});
