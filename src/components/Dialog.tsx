import { useEffect, useMemo, useRef, useState } from "react";
import { closeDialog, useDialog, type DialogRequest } from "../dialogs";

export default function Dialog() {
  const current = useDialog((s) => s.current);
  if (!current) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeDialog(null)}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={current.title}>
        {/* Keyed so each request starts with fresh state. */}
        {current.kind === "input" ? (
          <InputDialog key={current.id} request={current} />
        ) : (
          <PickDialog key={current.id} request={current} />
        )}
      </div>
    </div>
  );
}

function InputDialog({ request }: { request: Extract<DialogRequest, { kind: "input" }> }) {
  const [value, setValue] = useState(request.initial ?? "");
  const [touched, setTouched] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);

  const error = request.validate?.(value) ?? null;
  const empty = !request.allowEmpty && value.trim() === "";
  const submit = () => {
    setTouched(true);
    if (!error && !empty) closeDialog(value.trim());
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => e.key === "Escape" && closeDialog(null)}
    >
      <div className="dialog-title">{request.title}</div>
      {request.message && <p className="dialog-message">{request.message}</p>}
      <input
        ref={input}
        className="dialog-input"
        value={value}
        placeholder={request.placeholder}
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value);
          setTouched(true);
        }}
        aria-invalid={touched && !!error}
      />
      {touched && error && <div className="dialog-error">{error}</div>}
      <div className="dialog-buttons">
        <button type="button" className="btn" onClick={() => closeDialog(null)}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!!error || empty}>
          {request.okLabel}
        </button>
      </div>
    </form>
  );
}

function PickDialog({ request }: { request: Extract<DialogRequest, { kind: "pick" }> }) {
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return request.items;
    return request.items.filter((i) => `${i.label} ${i.detail ?? ""}`.toLowerCase().includes(q));
  }, [filter, request.items]);

  useEffect(() => setIndex(0), [filter]);
  useEffect(() => {
    list.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape") closeDialog(null);
        else if (e.key === "ArrowDown") {
          e.preventDefault();
          setIndex((i) => Math.min(i + 1, items.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter" && items[index]) {
          e.preventDefault();
          closeDialog(items[index].value);
        }
      }}
    >
      <div className="dialog-title">{request.title}</div>
      <input
        autoFocus
        className="dialog-input"
        value={filter}
        placeholder={request.placeholder ?? "Type to filter"}
        spellCheck={false}
        onChange={(e) => setFilter(e.target.value)}
        role="combobox"
        aria-expanded="true"
        aria-controls="pick-list"
      />
      <div className="pick-list" id="pick-list" role="listbox" ref={list}>
        {items.length === 0 && <div className="pick-empty">No matches</div>}
        {items.map((item, i) => (
          <div
            key={i}
            role="option"
            aria-selected={i === index}
            className={`pick-item ${i === index ? "active" : ""}`}
            onMouseMove={() => setIndex(i)}
            onClick={() => closeDialog(item.value)}
          >
            <span className="pick-label">{item.label}</span>
            {item.detail && <span className="pick-detail">{item.detail}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
