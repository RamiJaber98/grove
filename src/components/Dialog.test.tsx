import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { closeDialog, pick, promptText } from "../dialogs";
import Dialog from "./Dialog";

afterEach(() => {
  act(() => closeDialog(null));
});

/** Opens a dialog through the public API and renders it. */
function open<T>(show: () => Promise<T>) {
  render(<Dialog />);
  let result!: Promise<T>;
  act(() => {
    result = show();
  });
  return result;
}

describe("Dialog (text input)", () => {
  it("renders nothing when no dialog is open", () => {
    const { container } = render(<Dialog />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the title, message and initial value", () => {
    open(() => promptText({ title: "Rename Branch", message: "New name:", initial: "main", okLabel: "Rename" }));
    expect(screen.getByRole("dialog", { name: "Rename Branch" })).toBeTruthy();
    expect(screen.getByText("New name:")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("main");
    expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
  });

  it("submits the trimmed value on Enter", async () => {
    const user = userEvent.setup();
    const result = open(() => promptText({ title: "Branch" }));
    await user.type(screen.getByRole("textbox"), "  feature/x  {Enter}");
    await expect(result).resolves.toBe("feature/x");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables OK while the value is empty", async () => {
    const user = userEvent.setup();
    const result = open(() => promptText({ title: "Branch" }));
    const ok = screen.getByRole("button", { name: "OK" }) as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    await user.type(screen.getByRole("textbox"), "   {Enter}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.type(screen.getByRole("textbox"), "x");
    expect(ok.disabled).toBe(false);
    await user.click(ok);
    await expect(result).resolves.toBe("x");
  });

  it("allows an empty value when asked to", async () => {
    const user = userEvent.setup();
    const result = open(() => promptText({ title: "Message", allowEmpty: true }));
    await user.type(screen.getByRole("textbox"), "{Enter}");
    await expect(result).resolves.toBe("");
  });

  it("shows validation errors and blocks submission", async () => {
    const user = userEvent.setup();
    const result = open(() =>
      promptText({ title: "Branch", validate: (v) => (v.includes(" ") ? "No spaces allowed" : null) }),
    );
    const input = screen.getByRole("textbox");
    await user.type(input, "a b");
    expect(screen.getByText("No spaces allowed")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByRole("button", { name: "OK" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(input, "{Enter}");
    expect(screen.getByRole("dialog")).toBeTruthy();

    await user.clear(input);
    await user.type(input, "ab{Enter}");
    expect(screen.queryByText("No spaces allowed")).toBeNull();
    await expect(result).resolves.toBe("ab");
  });

  it("does not show a validation error before the user types", () => {
    open(() => promptText({ title: "Branch", initial: "a b", validate: () => "Invalid" }));
    expect(screen.queryByText("Invalid")).toBeNull();
  });

  it("cancels on Escape", async () => {
    const user = userEvent.setup();
    const result = open(() => promptText({ title: "Branch" }));
    await user.type(screen.getByRole("textbox"), "abc{Escape}");
    await expect(result).resolves.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels with the Cancel button", async () => {
    const user = userEvent.setup();
    const result = open(() => promptText({ title: "Branch" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(result).resolves.toBeNull();
  });
});

describe("Dialog (picker)", () => {
  const items = [
    { label: "main", detail: "origin/main", value: "main" },
    { label: "feature/login", detail: "2 days ago", value: "login" },
    { label: "feature/logout", value: "logout" },
    { label: "release", detail: "tagged v1", value: "release" },
  ];
  const labels = () => screen.queryAllByRole("option").map((o) => o.querySelector(".pick-label")!.textContent);
  const active = () => screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");

  it("lists all items with the first one active", () => {
    open(() => pick({ title: "Checkout", items }));
    expect(labels()).toEqual(["main", "feature/login", "feature/logout", "release"]);
    expect(active()?.textContent).toContain("main");
  });

  it("filters by label and detail, case-insensitively", async () => {
    const user = userEvent.setup();
    open(() => pick({ title: "Checkout", items }));
    const input = screen.getByRole("combobox");
    await user.type(input, "LOG");
    expect(labels()).toEqual(["feature/login", "feature/logout"]);
    await user.clear(input);
    await user.type(input, "tagged");
    expect(labels()).toEqual(["release"]);
    await user.clear(input);
    await user.type(input, "zzz");
    expect(labels()).toEqual([]);
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("moves the selection with the arrow keys and picks with Enter", async () => {
    const user = userEvent.setup();
    const result = open(() => pick({ title: "Checkout", items }));
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(active()?.textContent).toContain("feature/logout");
    await user.keyboard("{ArrowUp}");
    expect(active()?.textContent).toContain("feature/login");
    await user.keyboard("{Enter}");
    await expect(result).resolves.toBe("login");
  });

  it("clamps the selection to the list", async () => {
    const user = userEvent.setup();
    const result = open(() => pick({ title: "Checkout", items }));
    await user.keyboard("{ArrowUp}");
    expect(active()?.textContent).toContain("main");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(active()?.textContent).toContain("release");
    await user.keyboard("{Enter}");
    await expect(result).resolves.toBe("release");
  });

  it("resets the selection to the first match when the filter changes", async () => {
    const user = userEvent.setup();
    const result = open(() => pick({ title: "Checkout", items }));
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    await user.type(screen.getByRole("combobox"), "feature");
    expect(active()?.textContent).toContain("feature/login");
    await user.keyboard("{ArrowDown}{Enter}");
    await expect(result).resolves.toBe("logout");
  });

  it("ignores Enter when nothing matches", async () => {
    const user = userEvent.setup();
    const result = open(() => pick({ title: "Checkout", items }));
    await user.type(screen.getByRole("combobox"), "zzz{Enter}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    await expect(result).resolves.toBeNull();
  });

  it("picks an item on click", async () => {
    const user = userEvent.setup();
    const result = open(() => pick({ title: "Checkout", items }));
    await user.click(screen.getByText("release"));
    await expect(result).resolves.toBe("release");
  });

  it("cancels when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    const result = open(() => pick({ title: "Checkout", items }));
    await user.click(document.querySelector(".dialog-backdrop")!);
    await expect(result).resolves.toBeNull();
  });
});
