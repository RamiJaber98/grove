import { beforeEach, describe, expect, it, vi } from "vitest";
import * as actions from "./actions";
import { runCommand } from "./runCommand";

const store = vi.hoisted(() => ({
  refresh: vi.fn(),
  toast: vi.fn(),
  setView: vi.fn(),
  view: "changes",
}));

vi.mock("./store/repo", () => ({ useRepo: { getState: () => store } }));
vi.mock("./actions", () => ({
  commit: vi.fn(),
  amend: vi.fn(),
  remote: vi.fn(),
}));
vi.mock("./refActions", () => ({}));
vi.mock("./repoActions", () => ({}));
vi.mock("./dialogs", () => ({ openPanel: vi.fn() }));
vi.mock("./diffEditorHandle", () => ({ getActiveDiffEditor: () => null }));

// runCommand remembers the last command across calls, so each test starts
// well past the de-duplication window of the previous one.
let clock = 0;
const now = vi.fn(() => clock);
beforeEach(() => {
  clock += 10_000;
  vi.spyOn(performance, "now").mockImplementation(now);
});

describe("runCommand", () => {
  it("dispatches to the matching action", async () => {
    await runCommand("commit");
    await runCommand("push");
    expect(actions.commit).toHaveBeenCalledTimes(1);
    expect(actions.remote).toHaveBeenCalledWith("push");
  });

  it("runs a command repeated within 150 ms only once", async () => {
    await runCommand("refresh");
    clock += 149;
    await runCommand("refresh");
    expect(store.refresh).toHaveBeenCalledTimes(1);
  });

  it("runs the same command again after 150 ms", async () => {
    await runCommand("refresh");
    clock += 150;
    await runCommand("refresh");
    expect(store.refresh).toHaveBeenCalledTimes(2);
  });

  it("measures the window from the last run, not the last duplicate", async () => {
    await runCommand("refresh");
    clock += 100;
    await runCommand("refresh"); // dropped
    clock += 100;
    await runCommand("refresh"); // 200 ms after the first run
    expect(store.refresh).toHaveBeenCalledTimes(2);
  });

  it("does not de-duplicate different commands", async () => {
    await runCommand("commit");
    await runCommand("commit_amend");
    await runCommand("commit");
    expect(actions.commit).toHaveBeenCalledTimes(2);
    expect(actions.amend).toHaveBeenCalledTimes(1);
  });

  it("reports unknown commands", async () => {
    await runCommand("no_such_command");
    expect(store.toast).toHaveBeenCalledWith("Unknown command: no_such_command", "error");
  });
});
