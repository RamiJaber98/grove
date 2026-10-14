/**
 * Viewers for files a text diff can't show well: images, submodules and Git
 * LFS pointers. DiffView and HistoryView ask `extraDiff` first and fall back
 * to Monaco when it returns null.
 */
import type { ReactNode } from "react";
import type { FileVersions } from "../api/git";
import type { Signature } from "../api/extras";
import { formatSize, lfsPointerSize, useExtras } from "../extrasActions";
import ImageDiff, { isImagePath } from "./ImageDiff";
import SubmoduleDiff from "./SubmoduleDiff";

export interface ExtraDiffProps {
  root: string;
  group: string;
  path: string;
  from?: string;
  rev?: string;
  /** The path is a submodule (from status or commit detail). */
  submodule: boolean;
  /** Text versions, once loaded; needed to spot LFS pointers. */
  versions: FileVersions | null;
  version?: number;
}

export function extraDiff(p: ExtraDiffProps): ReactNode | null {
  if (p.submodule) return <SubmoduleDiff root={p.root} group={p.group} path={p.path} rev={p.rev} version={p.version} />;
  if (isImagePath(p.path)) {
    return <ImageDiff root={p.root} group={p.group} path={p.path} from={p.from} rev={p.rev} version={p.version} />;
  }
  if (p.versions) {
    const sizes = [p.versions.original, p.versions.modified].map((s) => (s.exists ? lfsPointerSize(s.text) : null));
    if (sizes.some((s) => s !== null)) return <LfsNotice sizes={sizes} />;
  }
  return null;
}

function LfsNotice({ sizes }: { sizes: (number | null)[] }) {
  const lfs = useExtras((s) => s.lfs);
  const text = sizes.map((s) => (s === null ? "—" : formatSize(s))).join(" → ");
  return (
    <div className="empty">
      <p>Stored in Git LFS ({text})</p>
      <p className="muted">
        {lfs && !lfs.installed
          ? "Git LFS isn't installed, so only the pointer file is available."
          : "Use ⋯ › Fetch LFS Objects to download the content."}
      </p>
    </div>
  );
}

const SIGNATURE: Record<Signature["status"], { label: string; kind: "good" | "warn" | "bad"; text: string } | null> = {
  G: { label: "Verified", kind: "good", text: "Good signature" },
  U: { label: "Signed", kind: "warn", text: "Good signature from a key that isn't trusted" },
  X: { label: "Expired", kind: "warn", text: "Good signature, but the signature has expired" },
  Y: { label: "Expired key", kind: "warn", text: "Good signature made by a key that has since expired" },
  R: { label: "Revoked", kind: "bad", text: "Signed with a revoked key" },
  B: { label: "Bad signature", kind: "bad", text: "The signature doesn't match this commit" },
  E: { label: "Signed", kind: "warn", text: "Signed, but the signature can't be checked (missing key or gpg/ssh-keygen)" },
  N: null,
};

/** Small badge for the commit detail pane; renders nothing for unsigned commits. */
export function SignatureBadge({ signature }: { signature?: Signature }) {
  const info = signature && SIGNATURE[signature.status];
  if (!signature || !info) return null;
  const tooltip = [info.text, signature.signer && `Signer: ${signature.signer}`, signature.key && `Key: ${signature.key}`]
    .filter(Boolean)
    .join("\n");
  return (
    <span className={`sig-badge ${info.kind}`} title={tooltip}>
      {info.label}
    </span>
  );
}

/** Marks a submodule in file lists. */
export function SubmoduleMark() {
  return (
    <span className="submodule-mark" title="Submodule" aria-label="Submodule">
      <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
        <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
        <rect x="5" y="5" width="6" height="6" rx="1" />
      </svg>
    </span>
  );
}
