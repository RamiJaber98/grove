import { useRepo } from "../store/repo";

export default function Toasts() {
  const toasts = useRepo((s) => s.toasts);
  const dismiss = useRepo((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
