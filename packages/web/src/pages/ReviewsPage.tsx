import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ReviewRow } from "../api";
import { StatusBadge, timeAgo } from "../components";

export default function ReviewsPage() {
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [filter, setFilter] = useState("pending");
  const [error, setError] = useState<string>();
  const navigate = useNavigate();

  useEffect(() => {
    api
      .reviews(filter === "all" ? undefined : filter)
      .then(setReviews)
      .catch((e) => setError(e.message));
  }, [filter]);

  return (
    <>
      <div className="page-head">
        <h1>Reviews</h1>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
      </div>
      {error && <div className="error-banner">{error}</div>}

      {reviews.length === 0 ? (
        <div className="empty">No {filter === "all" ? "" : filter + " "}change requests.</div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Status</th>
              <th>Spec</th>
              <th>Project type</th>
              <th>Delta</th>
              <th>Proposed by</th>
              <th>Summary</th>
              <th>Result</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {reviews.map((r) => (
              <tr key={r.id} className="click" onClick={() => navigate(`/reviews/${r.id}`)}>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td className="mono">{r.filename}</td>
                <td>{r.project_type_name}</td>
                <td className="mono">{r.version_delta}</td>
                <td>{r.proposed_by}</td>
                <td className="dim">{r.summary ?? "—"}</td>
                <td className="mono">{r.resulting_version ?? "—"}</td>
                <td className="faint">{timeAgo(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
