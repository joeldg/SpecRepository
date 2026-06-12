import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type FeedbackRow } from "../api";
import { StatusBadge, timeAgo } from "../components";

export default function FeedbackPage() {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [filter, setFilter] = useState("open");
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    api
      .feedback(filter === "all" ? undefined : filter)
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [filter]);

  useEffect(reload, [reload]);

  async function setStatus(id: string, status: string) {
    try {
      await api.setFeedbackStatus(id, status);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>AI Agent Feedback</h1>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </select>
      </div>
      {error && <div className="error-banner">{error}</div>}

      {rows.length === 0 ? (
        <div className="empty">No {filter === "all" ? "" : filter + " "}feedback.</div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Status</th>
              <th>Type</th>
              <th>Spec</th>
              <th>Version</th>
              <th>Agent</th>
              <th>Description</th>
              <th>When</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id}>
                <td>
                  <StatusBadge status={f.status} />
                </td>
                <td>
                  <StatusBadge status={f.error_type} />
                </td>
                <td className="mono">
                  <Link to={`/specs/${f.spec_id}`} style={{ textDecoration: "underline" }}>
                    {f.filename}
                  </Link>
                </td>
                <td className="mono">{f.spec_version}</td>
                <td className="mono dim">{f.agent_identifier}</td>
                <td className="feedback-desc">
                  {f.description}
                  {f.context_code_snippet && (
                    <pre className="mono faint" style={{ margin: "6px 0 0" }}>{f.context_code_snippet}</pre>
                  )}
                </td>
                <td className="faint">{timeAgo(f.created_at)}</td>
                <td>
                  {f.status === "open" && (
                    <button onClick={() => setStatus(f.id, "acknowledged")}>Acknowledge</button>
                  )}
                  {f.status === "acknowledged" && (
                    <button onClick={() => setStatus(f.id, "resolved")}>Resolve</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
