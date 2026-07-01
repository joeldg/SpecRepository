import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type FeedbackCluster, type FeedbackRow } from "../api";
import { StatusBadge, timeAgo } from "../components";

export default function FeedbackPage() {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [clusters, setClusters] = useState<FeedbackCluster[]>([]);
  const [filter, setFilter] = useState("open");
  const [error, setError] = useState<string>();
  const [drafting, setDrafting] = useState<string>();
  const navigate = useNavigate();

  const reload = useCallback(() => {
    Promise.all([
      api.feedback(filter === "all" ? undefined : filter),
      api.feedbackClusters(filter === "all" ? undefined : filter),
    ])
      .then(([feedback, grouped]) => {
        setRows(feedback);
        setClusters(grouped);
      })
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

  async function draftFix(id: string) {
    setError(undefined);
    setDrafting(id);
    try {
      const cr = await api.draftFix(id);
      navigate(`/reviews/${cr.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDrafting(undefined);
    }
  }

  async function setClusterStatus(key: string, status: string) {
    try {
      await api.setFeedbackClusterStatus(key, status);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function draftClusterFix(key: string) {
    setError(undefined);
    setDrafting(key);
    try {
      const cr = await api.draftClusterFix(key);
      navigate(`/reviews/${cr.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDrafting(undefined);
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

      {clusters.length > 0 && (
        <div className="section">
          <h2>Clusters</h2>
          <table className="grid">
            <thead>
              <tr>
                <th>Count</th>
                <th>Type</th>
                <th>Spec</th>
                <th>Sample</th>
                <th>Latest</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {clusters.slice(0, 8).map((c) => (
                <tr key={c.key}>
                  <td className="mono">{c.count}</td>
                  <td>
                    <StatusBadge status={c.error_type} />
                  </td>
                  <td className="mono">
                    {c.spec_id ? (
                      <span className="click" onClick={() => navigate(`/specs/${c.spec_id}`)}>{c.filename}</span>
                    ) : (
                      <span className="dim">— (guidance gap: {c.project_type_name ?? "unknown type"})</span>
                    )}
                  </td>
                  <td className="feedback-desc dim">{c.sample_description}</td>
                  <td className="faint">{timeAgo(c.latest_at)}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {c.spec_id && (
                        <button disabled={drafting === c.key} onClick={() => draftClusterFix(c.key)}>
                          {drafting === c.key ? "Drafting..." : "Draft fix"}
                        </button>
                      )}
                      {filter === "open" && <button onClick={() => setClusterStatus(c.key, "acknowledged")}>Ack cluster</button>}
                      {filter !== "resolved" && <button onClick={() => setClusterStatus(c.key, "resolved")}>Resolve cluster</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
                  {f.spec_id ? (
                    <Link to={`/specs/${f.spec_id}`} style={{ textDecoration: "underline" }}>
                      {f.filename}
                    </Link>
                  ) : (
                    <span className="dim">— (guidance gap: {f.project_type_name ?? "unknown type"})</span>
                  )}
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
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {f.status !== "resolved" && f.spec_id && (
                      <button className="primary" disabled={drafting === f.id} onClick={() => draftFix(f.id)}>
                        {drafting === f.id ? "Drafting…" : "Draft AI fix"}
                      </button>
                    )}
                    {f.status === "open" && (
                      <button onClick={() => setStatus(f.id, "acknowledged")}>Acknowledge</button>
                    )}
                    {f.status === "acknowledged" && (
                      <button onClick={() => setStatus(f.id, "resolved")}>Resolve</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
