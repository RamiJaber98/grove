/**
 * Branch › Compare…: pick two refs (branches, tags, recent commits, or a
 * typed ref), or a ref and the working tree, and open the Compare tab.
 */
import { errorMessage, git } from "./api/git";
import { pick, promptText, type PickItem } from "./dialogs";
import { ago } from "./refActions";
import { openCompare } from "./store/compare";
import { useRepo } from "./store/repo";

type Ref = { ref: string; label: string };
const TYPE_REF = "\0type";
const WORKTREE = "\0worktree";

async function refItems(root: string): Promise<PickItem<string>[]> {
  const [branches, tags, commits] = await Promise.all([
    git.branches(root),
    git.tags(root),
    git.recentCommits(root, 30).catch(() => []),
  ]);
  // Current branch first so Enter picks it: it's the usual "A".
  const sorted = [...branches].sort((x, y) => Number(y.current) - Number(x.current));
  const head: PickItem<string>[] = sorted.some((b) => b.current)
    ? []
    : [{ label: "HEAD", detail: "detached", value: "HEAD" }];
  return [
    ...head,
    ...sorted.map((b) => ({
      label: b.current ? `● ${b.name}` : b.remote ? `${b.name}  (remote)` : b.name,
      detail: `${b.hash} · ${b.subject} · ${ago(b.time)}`,
      value: b.name,
    })),
    ...tags.map((t) => ({ label: `${t.name}  (tag)`, detail: t.subject, value: t.name })),
    ...commits.map((c) => ({ label: `${c.short}  ${c.subject}`, detail: `${c.author} · ${ago(c.time)}`, value: c.hash })),
    { label: "Enter a ref or commit hash…", value: TYPE_REF },
  ];
}

async function pickRef(title: string, items: PickItem<string>[]): Promise<Ref | null> {
  const value = await pick({ title, placeholder: "Branch, tag or commit", items });
  if (value === null) return null;
  if (value === WORKTREE) return { ref: WORKTREE, label: "Working tree" };
  if (value === TYPE_REF) {
    const typed = await promptText({
      title,
      placeholder: "e.g. main~3, v1.0, a1b2c3d",
      okLabel: "Compare",
      validate: (v) => (v.trim().startsWith("-") ? 'A ref can\'t start with "-".' : null),
    });
    return typed ? { ref: typed.trim(), label: typed.trim() } : null;
  }
  // Commits are listed by full hash; show the short form in the header.
  return { ref: value, label: /^[0-9a-f]{40,64}$/.test(value) ? value.slice(0, 7) : value };
}

export async function compareRefs() {
  const s = useRepo.getState();
  if (!s.repo) return;
  let items: PickItem<string>[];
  try {
    items = await refItems(s.repo.root);
  } catch (e) {
    return s.toast(errorMessage(e), "error");
  }
  const a = await pickRef("Compare: pick the base (A)", items);
  if (!a) return;
  const b = await pickRef(`Compare ${a.label} with… (B)`, [
    { label: "Working tree", detail: "uncommitted changes included", value: WORKTREE },
    ...items.filter((i) => i.value !== a.ref),
  ]);
  if (!b) return;
  openCompare({
    a: a.ref,
    aLabel: a.label,
    b: b.ref === WORKTREE ? null : b.ref,
    bLabel: b.ref === WORKTREE ? undefined : b.label,
  });
}
