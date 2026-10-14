import { afterEach, describe, expect, it } from "vitest";
import { closeDialog, openPanel, pick, promptText, useDialog, usePanel } from "./dialogs";

afterEach(() => {
  closeDialog(null);
  openPanel(null);
});

describe("promptText", () => {
  it("shows an input request with defaults", () => {
    promptText({ title: "Branch name" });
    expect(useDialog.getState().current).toMatchObject({
      kind: "input",
      title: "Branch name",
      okLabel: "OK",
      allowEmpty: false,
    });
  });

  it("lets options override the defaults", () => {
    promptText({ title: "T", okLabel: "Create", allowEmpty: true, initial: "x" });
    expect(useDialog.getState().current).toMatchObject({ okLabel: "Create", allowEmpty: true, initial: "x" });
  });

  it("resolves with the submitted value and clears the dialog", async () => {
    const result = promptText({ title: "T" });
    closeDialog("feature/x");
    await expect(result).resolves.toBe("feature/x");
    expect(useDialog.getState().current).toBeNull();
  });

  it("resolves null when cancelled", async () => {
    const result = promptText({ title: "T" });
    closeDialog(null);
    await expect(result).resolves.toBeNull();
  });
});

describe("pick", () => {
  it("resolves with the chosen item's value", async () => {
    const items = [
      { label: "main", value: { name: "main" } },
      { label: "dev", value: { name: "dev" } },
    ];
    const result = pick({ title: "Branch", items });
    expect(useDialog.getState().current).toMatchObject({ kind: "pick", title: "Branch", items });
    closeDialog(items[1].value);
    await expect(result).resolves.toBe(items[1].value);
  });

  it("resolves null when cancelled", async () => {
    const result = pick({ title: "Branch", items: [{ label: "a", value: 1 }] });
    closeDialog(null);
    await expect(result).resolves.toBeNull();
  });
});

describe("one dialog at a time", () => {
  it("cancels the previous dialog when a new one opens", async () => {
    const first = promptText({ title: "First" });
    const second = pick({ title: "Second", items: [{ label: "a", value: "a" }] });
    await expect(first).resolves.toBeNull();
    expect(useDialog.getState().current?.title).toBe("Second");
    closeDialog("a");
    await expect(second).resolves.toBe("a");
  });

  it("gives each request a new id", () => {
    promptText({ title: "A" });
    const a = useDialog.getState().current!.id;
    promptText({ title: "B" });
    expect(useDialog.getState().current!.id).toBeGreaterThan(a);
  });

  it("closing with nothing open is harmless", () => {
    expect(() => closeDialog("x")).not.toThrow();
    expect(useDialog.getState().current).toBeNull();
  });
});

describe("openPanel", () => {
  it("sets and clears the open panel", () => {
    openPanel("settings");
    expect(usePanel.getState().panel).toBe("settings");
    openPanel(null);
    expect(usePanel.getState().panel).toBeNull();
  });
});
