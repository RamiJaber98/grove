import { runCommand } from "../runCommand";
import { useRepo } from "../store/repo";
import { Branch, Refresh } from "./Icons";

export default function StatusBar() {
  const repo = useRepo((s) => s.repo)!;

  return (
    <footer className="statusbar">
      <button className="status-item" onClick={() => runCommand("checkout_branch")} title="Switch branch">
        <Branch />
        <span>{repo.branch ?? "(detached HEAD)"}</span>
      </button>
      <button className="status-item" onClick={() => runCommand("refresh")} title="Refresh (F5)">
        <Refresh />
      </button>
      <span className="status-spacer" />
      <span className="status-item path" title={repo.root}>{repo.root}</span>
    </footer>
  );
}
