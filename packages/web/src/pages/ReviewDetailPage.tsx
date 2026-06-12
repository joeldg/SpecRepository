import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ChangeRequest, Spec } from "@specregistry/shared";
import { api, getAuthor } from "../api";
import { DiffView, StatusBadge, timeAgo } from "../components";

interface CompatReport {
  removed_sections: string[];
  added_sections: string[];
  suggested_delta: string;
  requested_delta: string;
  agrees_with_requested: boolean;
}

interface LintReport {
  missing_sections: string[];
  ok: boolean;
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

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

      {(() => {
        const compat = parseJson<CompatReport>((review as unknown as Record<string, unknown>).compatibility);
        const lint = parseJson<LintReport>((review as unknown as Record<string, unknown>).lint);
        if (!compat && !lint) return null;
        return (
          <div className="section">
            <h2>Automated checks</h2>
            <div className="cards">
              {compat && (
                <div className={`card${compat.agrees_with_requested ? "" : " alert"}`}>
                  <div className="label">Compatibility</div>
                  <div>
                    Suggested bump: <span className="mono">{compat.suggested_delta}</span>
                    {" · "}requested: <span className="mono">{compat.requested_delta}</span>{" "}
                    {compat.agrees_with_requested ? (
                      <span className="badge approved">ok</span>
                    ) : (
                      <span className="badge rejected">undersized</span>
                    )}
                  </div>
                  {compat.removed_sections.length > 0 && (
                    <div className="dim">Removes sections: {compat.removed_sections.join(", ")}</div>
                  )}
                  {compat.added_sections.length > 0 && (
                    <div className="dim">Adds sections: {compat.added_sections.join(", ")}</div>
                  )}
                </div>
              )}
              {lint && (
                <div className={`card${lint.ok ? "" : " alert"}`}>
                  <div className="label">Template conformance</div>
                  {lint.ok ? (
                    <div>
                      All required sections present <span className="badge approved">ok</span>
                    </div>
                  ) : (
                    <div>
                      Missing: {lint.missing_sections.join(", ")} <span className="badge rejected">lint</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })()}

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
