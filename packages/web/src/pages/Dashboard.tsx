import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SpecSummary } from "@specregistry/shared";
import { api, type FeedbackRow, type ReviewRow } from "../api";
import { StatusBadge, timeAgo } from "../components";

export default function Dashboard() {
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
  const [error, setError] = useState<string>();
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([api.specs(), api.reviews("pending"), api.feedback("open")])
      .then(([s, r, f]) => {
        setSpecs(s);
        setReviews(r);
        setFeedback(f);
      })
      .catch((e) => setError(e.message));
  }, []);

  const published = specs.filter((s) => s.status === "published").length;

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
        <span className="sub">Registry health at a glance</span>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="cards">
        <div className="card">
          <div className="metric">{specs.length}</div>
          <div className="label">Specifications</div>
        </div>
        <div className="card">
          <div className="metric">{published}</div>
          <div className="label">Published</div>
        </div>
        <div className={`card${reviews.length ? " alert" : ""}`}>
          <div className="metric">{reviews.length}</div>
          <div className="label">Pending reviews</div>
        </div>
        <div className={`card${feedback.length ? " alert" : ""}`}>
          <div className="metric">{feedback.length}</div>
          <div className="label">Open AI feedback alerts</div>
        </div>
      </div>

      <div className="section">
        <h2>Open AI feedback</h2>
        {feedback.length === 0 ? (
          <div className="empty">No open alerts. Agents are happy.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Spec</th>
                <th>Version</th>
                <th>Type</th>
                <th>Agent</th>
                <th>Description</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {feedback.map((f) => (
                <tr key={f.id} className="click" onClick={() => navigate(`/specs/${f.spec_id}`)}>
                  <td className="mono">{f.filename}</td>
                  <td className="mono">{f.spec_version}</td>
                  <td>
                    <StatusBadge status={f.error_type} />
                  </td>
                  <td className="mono dim">{f.agent_identifier}</td>
                  <td className="feedback-desc dim">{f.description}</td>
                  <td className="faint">{timeAgo(f.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="section">
        <h2>Pending reviews</h2>
        {reviews.length === 0 ? (
          <div className="empty">Review queue is clear.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Spec</th>
                <th>Project type</th>
                <th>Delta</th>
                <th>Proposed by</th>
                <th>Summary</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((r) => (
                <tr key={r.id} className="click" onClick={() => navigate(`/reviews/${r.id}`)}>
                  <td className="mono">{r.filename}</td>
                  <td>{r.project_type_name}</td>
                  <td className="mono">{r.version_delta}</td>
                  <td>{r.proposed_by}</td>
                  <td className="dim">{r.summary ?? "—"}</td>
                  <td className="faint">{timeAgo(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
