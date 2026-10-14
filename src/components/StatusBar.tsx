import { runCommand } from "../runCommand";
import { useRepo } from "../store/repo";
import { ArrowDown, ArrowUp, Branch, Refresh, Spinner } from "./Icons";

export default function StatusBar() {
  const repo = useRepo((s) => s.repo)!;
  const branch = useRepo((s) => s.branch);
  const upstream = useRepo((s) => s.upstream);
  const ahead = useRepo((s) => s.ahead);
  const behind = useRepo((s) => s.behind);
  const busy = useRepo((s) => s.busy);

  return (
    <footer className="statusbar">
      <button className="status-item" onClick={() => runCommand("checkout_branch")} title="Switch branch">
        <Branch />
        <span>{branch ?? "(detached HEAD)"}</span>
      </button>
      {upstream && (
        <button
          className="status-item"
          onClick={() => runCommand("sync")}
          title={`${behind} to pull, ${ahead} to push (${upstream})`}
        >
          <ArrowDown size={12} />
          {behind}
          <ArrowUp size={12} />
          {ahead}
        </button>
      )}
      <button className="status-item" onClick={() => runCommand("refresh")} title="Refresh (F5)">
        <Refresh />
      </button>
      {busy && (
        <span className="status-busy" role="status">
          <Spinner size={12} /> {busy}
        </span>
      )}
      <span className="status-spacer" />
      <span className="status-item path" title={repo.root}>{repo.root}</span>
    </footer>
  );
}
