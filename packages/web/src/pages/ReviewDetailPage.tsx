import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ChangeRequest, Spec } from "@specregistry/shared";
import { api, getAuthor } from "../api";
import { DiffView, StatusBadge, timeAgo } from "../components";

export default function ReviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [review, setReview] = useState<ChangeRequest & { spec: Spec }>();
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    if (!id) return;
    api
      .review(id)
      .then(setReview)
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(reload, [reload]);

  if (!review) {
    return error ? <div className="error-banner">{error}</div> : <p className="dim">Loading…</p>;
  }

  async function decide(action: "approve" | "reject") {
    setError(undefined);
    try {
      if (action === "approve") await api.approveReview(review!.id, getAuthor());
      else await api.rejectReview(review!.id, getAuthor());
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>
          Change request · <span className="mono">{review.spec.filename}</span>{" "}
          <StatusBadge status={review.status} />
        </h1>
        <span className="sub">
          <Link to={`/specs/${review.spec.id}`} style={{ textDecoration: "underline" }}>
            View spec
          </Link>
        </span>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="cards">
        <div className="card">
          <div className="label">Proposed by</div>
          <div>{review.proposed_by}</div>
        </div>
        <div className="card">
          <div className="label">Version delta</div>
          <div className="mono">
            {review.spec.current_version} → {review.version_delta}
            {review.resulting_version ? ` (${review.resulting_version})` : ""}
          </div>
        </div>
        <div className="card">
          <div className="label">Submitted</div>
          <div>{timeAgo(review.created_at)}</div>
        </div>
        <div className="card">
          <div className="label">Reviewed</div>
          <div>{review.reviewed_by ? `${review.reviewed_by} · ${timeAgo(review.reviewed_at!)}` : "—"}</div>
        </div>
      </div>

      {review.summary && (
        <div className="section">
          <h2>Summary</h2>
          <p>{review.summary}</p>
        </div>
      )}

      {review.status === "pending" && (
        <div className="toolbar">
          <button className="success" onClick={() => decide("approve")}>
            Approve &amp; publish
          </button>
          <button className="danger" onClick={() => decide("reject")}>
            Reject
          </button>
          <span className="faint">Acting as {getAuthor()}</span>
        </div>
      )}

      <div className="section">
        <h2>Diff</h2>
        <DiffView diff={review.diff} />
      </div>
    </>
  );
}
