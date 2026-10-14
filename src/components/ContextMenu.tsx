/**
 * Right-click menu, positioned at the cursor and styled like the ⋯
 * dropdown. One at a time, opened through `openContextMenu` from anywhere.
 * Arrow keys move between items, Escape / Tab / outside click close it,
 * and focus goes back to where it was.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

export type MenuItem =
  | { label: string; run: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | "separator";

interface MenuRequest {
  x: number;
  y: number;
  items: MenuItem[];
  /** Element to refocus on close (the row that was right-clicked). */
  returnFocus: HTMLElement | null;
}

const useMenu = create<{ menu: MenuRequest | null }>(() => ({ menu: null }));

export function openContextMenu(x: number, y: number, items: MenuItem[], returnFocus?: HTMLElement | null) {
  // Drop leading, trailing and doubled separators left by conditional items.
  const clean = items.filter(
    (it, i, all) => it !== "separator" || (i > 0 && i < all.length - 1 && all[i - 1] !== "separator"),
  );
  if (clean.length === 0) return;
  useMenu.setState({
    menu: { x, y, items: clean, returnFocus: returnFocus ?? (document.activeElement as HTMLElement | null) },
  });
}

function close(refocus: boolean) {
  const menu = useMenu.getState().menu;
  useMenu.setState({ menu: null });
  if (refocus && menu?.returnFocus?.isConnected) menu.returnFocus.focus();
}

const MARGIN = 4;

/** Mount once; renders the open menu (if any) into <body>. */
export default function ContextMenu() {
  const menu = useMenu((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);

  // Keep it on screen: flip left/up when it would overflow. Done before
  // paint, so the unadjusted position never shows.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu || !el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = menu.x + width + MARGIN > window.innerWidth ? Math.max(MARGIN, menu.x - width) : menu.x;
    const top = menu.y + height + MARGIN > window.innerHeight ? Math.max(MARGIN, menu.y - height) : menu.y;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close(false);
    };
    const onDismiss = () => close(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onDismiss);
    window.addEventListener("resize", onDismiss);
    // Scrolling the list underneath would leave the menu pointing at nothing.
    document.addEventListener("scroll", onDismiss, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onDismiss);
      window.removeEventListener("resize", onDismiss);
      document.removeEventListener("scroll", onDismiss, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (!menu) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (i + 1) % buttons.length;
    else if (e.key === "ArrowUp") next = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      return close(true);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      // Type-ahead: jump to the next item starting with that letter.
      const k = e.key.toLowerCase();
      const order = [...buttons.slice(i + 1), ...buttons.slice(0, i + 1)];
      const hit = order.find((b) => b.textContent?.trim().toLowerCase().startsWith(k));
      if (hit) next = buttons.indexOf(hit);
    }
    if (next !== null) {
      e.preventDefault();
      buttons[next]?.focus();
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="dropdown context-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="context-separator" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            tabIndex={-1}
            disabled={item.disabled}
            title={item.hint}
            className={`dropdown-item ${item.danger ? "danger" : ""}`}
            onClick={() => {
              close(true);
              item.run();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
