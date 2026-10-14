import { isTauri } from "../api/git";
import { pickAndOpenRepo } from "../runCommand";
import { useRepo } from "../store/repo";
import Logo from "./Logo";

export default function Welcome() {
  const recent = useRepo((s) => s.recent);
  const loading = useRepo((s) => s.loading);
  const openRepo = useRepo((s) => s.openRepo);

  return (
    <div className="welcome">
      <div className="welcome-card">
        <Logo size={56} />
        <h1>Grove</h1>
        <p className="muted">Open a git repository to see its changes.</p>
        {!isTauri && (
          <p className="warn">
            Running in a plain browser. Start the desktop app with <code>npm run app:dev</code>.
          </p>
        )}
        <button className="btn primary" onClick={pickAndOpenRepo} disabled={loading || !isTauri}>
          Open Repository…
        </button>
        {recent.length > 0 && (
          <div className="recent">
            <div className="section-label">Recent</div>
            {recent.map((path) => (
              <button
                key={path}
                className="recent-item"
                title={path}
                onClick={() => openRepo(path)}
                disabled={loading || !isTauri}
              >
                <span className="recent-name">{path.split("/").pop()}</span>
                <span className="recent-path">{path}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
