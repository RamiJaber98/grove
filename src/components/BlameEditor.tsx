import { useEffect, useMemo, useRef, useState } from "react";
import { monaco } from "../monaco";
import type { Blame, BlameCommit, BlameHunk } from "../api/fileHistory";
import { ago } from "../refActions";
import { useResolvedTheme } from "../theme";
import { useRepo } from "../store/repo";

interface Props {
  path: string;
  blame: Blame;
  /** Called with a commit hash when its annotation is clicked. */
  onPick: (hash: string) => void;
}

const FONT_FAMILY = '"Cascadia Code", "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace';
let modelSeq = 0;

/**
 * A read-only editor with a blame gutter beside it. The gutter is plain DOM
 * kept in step with the editor's scroll position rather than Monaco
 * decorations, so annotations can carry tooltips, clicks and age colours.
 * That needs one screen row per line, so wrapping and folding are off.
 */
export default function BlameEditor({ path, blame, onPick }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const shownPath = useRef<string | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 0, lineHeight: 20 });
  const [hovered, setHovered] = useState<string | null>(null);

  const fontSize = useRepo((s) => s.fontSize);
  const theme = useResolvedTheme();

  useEffect(() => {
    const e = monaco.editor.create(host.current!, {
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      folding: false,
      wordWrap: "off",
      glyphMargin: false,
      fontFamily: FONT_FAMILY,
      renderLineHighlight: "line",
    });
    editor.current = e;
    const sync = () =>
      setScroll({
        top: e.getScrollTop(),
        height: e.getLayoutInfo().height,
        lineHeight: e.getOption(monaco.editor.EditorOption.lineHeight),
      });
    const subs = [e.onDidScrollChange(sync), e.onDidLayoutChange(sync), e.onDidChangeConfiguration(sync)];
    sync();
    return () => {
      subs.forEach((s) => s.dispose());
      const model = e.getModel();
      e.dispose();
      model?.dispose();
      editor.current = null;
    };
  }, []);

  // New content: keep the scroll position when it's the same file refreshed.
  useEffect(() => {
    const e = editor.current!;
    const old = e.getModel();
    if (old && shownPath.current === path && old.getValue() === blame.text) return;
    const viewState = shownPath.current === path ? e.saveViewState() : null;
    const uri = monaco.Uri.from({ scheme: "grove-blame", path: `/${path}`, query: String(++modelSeq) });
    e.setModel(monaco.editor.createModel(blame.text, undefined, uri));
    old?.dispose();
    if (viewState) e.restoreViewState(viewState);
    shownPath.current = path;
  }, [path, blame.text]);

  useEffect(() => {
    editor.current!.updateOptions({ fontSize, lineHeight: Math.round(fontSize * 1.55) });
  }, [fontSize]);

  useEffect(() => {
    monaco.editor.setTheme(theme === "dark" ? "grove-dark" : "grove-light");
  }, [theme]);

  // Highlight the hovered commit's lines in the editor too.
  useEffect(() => {
    const e = editor.current;
    if (!e) return;
    const ranges = hovered ? blame.hunks.filter((h) => h.hash === hovered) : [];
    const decorations = e.createDecorationsCollection(
      ranges.map((h) => ({
        range: new monaco.Range(h.start, 1, h.start + h.count - 1, 1),
        options: { isWholeLine: true, className: "blame-line-hover" },
      })),
    );
    return () => decorations.clear();
  }, [hovered, blame]);

  const shade = useMemo(() => ageShades(blame.commits), [blame.commits]);

  // Only render annotations that are on screen; big files have thousands.
  const { top, height, lineHeight } = scroll;
  const visible = blame.hunks.filter((h) => {
    const y = (h.start - 1) * lineHeight;
    return y + h.count * lineHeight > top && y < top + height;
  });

  return (
    <div className="blame">
      <div className="blame-gutter" onMouseLeave={() => setHovered(null)}>
        {visible.map((h) => (
          <Annotation
            key={h.start}
            hunk={h}
            commit={blame.commits[h.hash]}
            shade={shade.get(h.hash) ?? 0}
            y={(h.start - 1) * lineHeight - top}
            lineHeight={lineHeight}
            fontSize={fontSize}
            hovered={hovered === h.hash}
            onHover={setHovered}
            onPick={onPick}
          />
        ))}
      </div>
      <div className="monaco-host" ref={host} />
    </div>
  );
}

function Annotation(props: {
  hunk: BlameHunk;
  commit: BlameCommit | undefined;
  shade: number;
  y: number;
  lineHeight: number;
  fontSize: number;
  hovered: boolean;
  onHover: (hash: string) => void;
  onPick: (hash: string) => void;
}) {
  const { hunk, commit, shade, y, lineHeight, fontSize, hovered, onHover, onPick } = props;
  const uncommitted = !commit || commit.uncommitted;
  const title = uncommitted
    ? "Not committed yet"
    : `${commit.short} · ${commit.author} · ${new Date(commit.time * 1000).toLocaleString()}\n${commit.summary}` +
      (commit.path ? `\n${commit.path}` : "");
  return (
    <div
      className={`blame-hunk ${uncommitted ? "uncommitted" : ""} ${hovered ? "hovered" : ""}`}
      style={{
        top: y,
        height: hunk.count * lineHeight,
        lineHeight: `${lineHeight}px`,
        fontSize: Math.max(10, fontSize - 1),
        // Newer commits get a stronger bar.
        borderLeftColor: uncommitted ? undefined : `color-mix(in srgb, var(--accent) ${Math.round(15 + 85 * shade)}%, transparent)`,
      }}
      title={title}
      onMouseEnter={() => onHover(hunk.hash)}
      onClick={() => !uncommitted && onPick(hunk.hash)}
    >
      {uncommitted ? (
        <span className="blame-author">Not committed yet</span>
      ) : (
        <>
          <span className="blame-hash">{commit.short}</span>
          <span className="blame-author">{commit.author}</span>
          <span className="blame-date">{ago(commit.time)}</span>
        </>
      )}
    </div>
  );
}

/** 0 for the oldest commit in the file, 1 for the newest, ranked so one
 * ancient commit doesn't wash out all the others. */
function ageShades(commits: Record<string, BlameCommit>) {
  const times = [...new Set(Object.values(commits).filter((c) => !c.uncommitted).map((c) => c.time))].sort((a, b) => a - b);
  const rank = new Map(times.map((t, i) => [t, times.length > 1 ? i / (times.length - 1) : 1]));
  return new Map(Object.values(commits).map((c) => [c.hash, rank.get(c.time) ?? 1]));
}
