import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri, network, type AskpassPrompt } from "../api/git";

/**
 * Credential prompt for git/ssh (username, password, key passphrase, host
 * key confirmation), relayed by the backend's askpass bridge. Separate from
 * the regular dialog store so it never cancels, or is cancelled by, another
 * dialog that happens to be open.
 */
export default function AskpassDialog() {
  const [request, setRequest] = useState<AskpassPrompt | null>(null);

  useEffect(() => {
    if (!isTauri) return;
    const subs = [
      listen<AskpassPrompt>("askpass", (e) => setRequest(e.payload)),
      // Timed out, or the operation was cancelled.
      listen<number>("askpass-closed", (e) => setRequest((r) => (r?.id === e.payload ? null : r))),
    ];
    return () => subs.forEach((s) => s.then((f) => f()));
  }, []);

  if (!request) return null;
  const finish = (answer: string | null) => {
    setRequest(null);
    network.answerPrompt(request.id, answer).catch(() => {});
  };
  return (
    <div className="dialog-backdrop askpass-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Authentication Required">
        <AskpassForm key={request.id} request={request} finish={finish} />
      </div>
    </div>
  );
}

function AskpassForm({ request, finish }: { request: AskpassPrompt; finish: (answer: string | null) => void }) {
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  // git/ssh prompts end with ": "; the input box makes that redundant.
  const text = request.prompt.trim().replace(/:$/, "");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // Not trimmed: passwords may legitimately start or end with spaces.
        finish(value);
        setValue("");
      }}
      onKeyDown={(e) => e.key === "Escape" && finish(null)}
    >
      <div className="dialog-title">Authentication Required</div>
      <p className="dialog-message askpass-prompt">{text}</p>
      <input
        ref={input}
        className="dialog-input"
        type={request.secret ? "password" : "text"}
        value={value}
        autoComplete="off"
        spellCheck={false}
        aria-label={text}
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="dialog-buttons">
        <button type="button" className="btn" onClick={() => finish(null)}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          OK
        </button>
      </div>
    </form>
  );
}
