import { useEffect, useState } from "react";
import { errorMessage } from "../api/git";
import { extras, type ImageSide, type ImageVersions } from "../api/extras";
import { formatSize } from "../extrasActions";
import { loadPref, savePref } from "../store/prefs";

type Mode = "side" | "swipe" | "onion";

const MODES: { mode: Mode; label: string }[] = [
  { mode: "side", label: "2-up" },
  { mode: "swipe", label: "Swipe" },
  { mode: "onion", label: "Onion skin" },
];

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;
export const isImagePath = (path: string) => IMAGE_EXT.test(path);

/** A data URL, so SVG renders as an image (no scripts, nothing inlined in the DOM). */
const src = (s: ImageSide) => `data:${s.mime};base64,${s.data}`;
const viewable = (s: ImageSide) => s.exists && s.data !== "";

type Dims = { w: number; h: number } | null;

/**
 * Visual diff for an image file: before and after next to each other, or
 * overlaid with a swipe divider or an opacity slider.
 */
export default function ImageDiff(props: {
  root: string;
  group: string;
  path: string;
  from?: string;
  rev?: string;
  /** Bumped to re-read (e.g. after a status refresh). */
  version?: number;
}) {
  const { root, group, path, from, rev, version } = props;
  const [loaded, setLoaded] = useState<{ key: string; v?: ImageVersions; error?: string } | null>(null);
  const [mode, setMode] = useState<Mode>(() => loadPref<Mode>("imageDiffMode", "side"));
  const [amount, setAmount] = useState(50);
  const [dims, setDims] = useState<{ before: Dims; after: Dims }>({ before: null, after: null });
  const key = `${root}|${group}|${rev ?? ""}|${from ?? ""}|${path}`;

  useEffect(() => {
    let stale = false;
    extras
      .imageVersions(root, group, path, from, rev)
      .then((v) => !stale && setLoaded({ key, v }))
      .catch((e) => !stale && setLoaded({ key, error: errorMessage(e) }));
    return () => {
      stale = true;
    };
  }, [key, version]);

  useEffect(() => setDims({ before: null, after: null }), [key]);

  const current = loaded?.key === key ? loaded : null;
  if (!current) return <div className="empty">Loading…</div>;
  if (current.error) return <div className="empty error">{current.error}</div>;
  const { original, modified } = current.v!;
  const both = viewable(original) && viewable(modified);
  const shown: Mode = both ? mode : "side";

  const choose = (m: Mode) => {
    setMode(m);
    savePref("imageDiffMode", m);
  };
  const onLoad = (which: "before" | "after") => (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setDims((d) => ({ ...d, [which]: { w: img.naturalWidth, h: img.naturalHeight } }));
  };

  return (
    <div className="image-diff">
      <div className="image-toolbar">
        <div className="segmented" role="radiogroup" aria-label="Image comparison">
          {MODES.map(({ mode: m, label }) => (
            <button
              key={m}
              role="radio"
              aria-checked={shown === m}
              className={shown === m ? "active" : ""}
              disabled={!both && m !== "side"}
              title={!both && m !== "side" ? "Needs both versions" : undefined}
              onClick={() => choose(m)}
            >
              {label}
            </button>
          ))}
        </div>
        {shown !== "side" && (
          <input
            type="range"
            min={0}
            max={100}
            value={amount}
            aria-label={shown === "swipe" ? "Divider position" : "After opacity"}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
        )}
      </div>

      {shown === "side" ? (
        <div className="image-panes">
          <Pane label="Before" side={original} dims={dims.before} onLoad={onLoad("before")} />
          <Pane label="After" side={modified} dims={dims.after} onLoad={onLoad("after")} />
        </div>
      ) : (
        <div className="image-overlay-wrap">
          <div className="image-overlay checker">
            <img src={src(original)} alt="Before" onLoad={onLoad("before")} draggable={false} />
            <img
              src={src(modified)}
              alt="After"
              onLoad={onLoad("after")}
              draggable={false}
              style={
                shown === "swipe"
                  ? { clipPath: `inset(0 0 0 ${amount}%)` }
                  : { opacity: amount / 100 }
              }
            />
            {shown === "swipe" && <div className="image-divider" style={{ left: `${amount}%` }} />}
          </div>
          <div className="image-caption">
            <Meta label="Before" side={original} dims={dims.before} /> · <Meta label="After" side={modified} dims={dims.after} />
          </div>
        </div>
      )}
    </div>
  );
}

function Meta({ label, side, dims }: { label: string; side: ImageSide; dims: Dims }) {
  return (
    <span>
      <strong>{label}</strong> {dims && dims.w > 0 ? `${dims.w} × ${dims.h} px · ` : ""}
      {formatSize(side.size)}
    </span>
  );
}

function Pane(props: {
  label: string;
  side: ImageSide;
  dims: Dims;
  onLoad: (e: React.SyntheticEvent<HTMLImageElement>) => void;
}) {
  const { label, side, dims, onLoad } = props;
  let body;
  if (!side.exists) body = <div className="image-missing">{label === "Before" ? "Added" : "Deleted"}</div>;
  else if (side.lfsSize !== undefined)
    body = <div className="image-missing">Stored in Git LFS ({formatSize(side.lfsSize)}); not fetched.</div>;
  else if (side.tooLarge) body = <div className="image-missing">Too large to preview ({formatSize(side.size)})</div>;
  else body = <img src={src(side)} alt={label} onLoad={onLoad} draggable={false} />;
  return (
    <figure className="image-pane">
      <figcaption>
        {side.exists && side.lfsSize === undefined ? <Meta label={label} side={side} dims={dims} /> : <strong>{label}</strong>}
      </figcaption>
      <div className={`image-frame ${viewable(side) ? "checker" : ""}`}>{body}</div>
    </figure>
  );
}
