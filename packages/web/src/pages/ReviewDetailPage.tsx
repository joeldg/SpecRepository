import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, getAuthor, type PublishPreview, type ReviewDetail } from "../api";
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

interface ContradictionReport {
  ok: boolean;
  finding_count: number;
  findings: Array<{
    severity: string;
    proposed_section: string;
    proposed_statement: string;
    conflicting_spec_id: string;
    conflicting_filename: string;
    conflicting_project_type_name: string;
    conflicting_section: string;
    conflicting_statement: string;
    reason: string;
  }>;
}

interface RiskReport {
  score: number;
  level: string;
  factors: string[];
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
  const [review, setReview] = useState<ReviewDetail>();
  const [preview, setPreview] = useState<PublishPreview>();
  const [error, setError] = useState<string>();
  const [approvalChannel, setApprovalChannel] = useState<"stable" | "beta">("stable");

  const reload = useCallback(() => {
    if (!id) return;
    api
      .review(id)
      .then(setReview)
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(reload, [reload]);
  useEffect(() => {
    if (!id) return;
    api.publishPreview(id).then(setPreview).catch(() => setPreview(undefined));
  }, [id]);

  if (!review) {
    return error ? <div className="error-banner">{error}</div> : <p className="dim">Loading…</p>;
  }

  async function decide(action: "approve" | "reject") {
    setError(undefined);
    try {
      if (action === "approve") await api.approveReview(review!.id, getAuthor(), approvalChannel);
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
        <div className={`card${review.status === "pending" && review.approval_count < review.required_approvals ? " alert" : ""}`}>
          <div className="label">Approvals</div>
          <div className="mono">
            {review.approval_count}/{review.required_approvals}
          </div>
        </div>
      </div>

      <div className="section">
        <h2>Approval route</h2>
        <div className="cards">
          <div className="card">
            <div className="label">Matched policy</div>
            <div className="mono">{review.approval_policy?.filename_glob ?? "default"}</div>
            {review.approval_policy?.required_reviewers.length ? (
              <div className="dim">Required reviewers: {review.approval_policy.required_reviewers.join(", ")}</div>
            ) : (
              <div className="dim">Any reviewer may approve.</div>
            )}
          </div>
          <div className="card">
            <div className="label">Recorded approvers</div>
            {review.approvals.length === 0 ? (
              <div className="dim">No approvals recorded yet.</div>
            ) : (
              review.approvals.map((approval) => (
                <div key={`${approval.reviewer}-${approval.created_at}`}>
                  {approval.reviewer} <span className="faint">{timeAgo(approval.created_at)}</span>
                </div>
              ))
            )}
          </div>
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
        const contradictions = parseJson<ContradictionReport>((review as unknown as Record<string, unknown>).contradictions);
        const risk = parseJson<RiskReport>((review as unknown as Record<string, unknown>).risk);
        if (!compat && !lint && !contradictions && !risk) return null;
        return (
          <div className="section">
            <h2>Automated checks</h2>
            <div className="cards">
              {risk && (
                <div className={`card${risk.level === "high" || risk.level === "critical" ? " alert" : ""}`}>
                  <div className="label">Risk score</div>
                  <div>
                    <span className="mono">{risk.score}/100</span> <StatusBadge status={risk.level} />
                  </div>
                  {risk.factors.length > 0 && <div className="dim">{risk.factors.join(" · ")}</div>}
                </div>
              )}
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
              {contradictions && (
                <div className={`card${contradictions.ok ? "" : " alert"}`}>
                  <div className="label">Cross-spec contradictions</div>
                  {contradictions.ok ? (
                    <div>
                      No contradictory normative statements found <span className="badge approved">ok</span>
                    </div>
                  ) : (
                    <div>
                      {contradictions.finding_count} possible conflict(s) <span className="badge rejected">review</span>
                      {contradictions.findings.slice(0, 3).map((finding, index) => (
                        <div key={`${finding.conflicting_spec_id}-${index}`} className="dim" style={{ marginTop: 8 }}>
                          <div>
                            Proposed <span className="mono">{finding.proposed_section}</span>: {finding.proposed_statement}
                          </div>
                          <div>
                            Conflicts with{" "}
                            <Link to={`/specs/${finding.conflicting_spec_id}`} style={{ textDecoration: "underline" }}>
                              {finding.conflicting_filename}
                            </Link>{" "}
                            <span className="mono">{finding.conflicting_section}</span>: {finding.conflicting_statement}
                          </div>
                        </div>
                      ))}
                    </div>
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
        <>
        {preview && (
          <div className="section">
            <h2>Dry-run publish preview</h2>
            <div className="cards">
              <div className="card">
                <div className="label">Affected repos</div>
                <div className="mono">{preview.affected_repositories.length}</div>
                {preview.affected_repositories.slice(0, 4).map((repo) => (
                  <div key={`${repo.repo}-${repo.branch}`} className="dim">{repo.repo}@{repo.branch}</div>
                ))}
              </div>
              <div className="card">
                <div className="label">Sync jobs</div>
                <div className="mono">{preview.sync_jobs_to_enqueue}</div>
              </div>
              <div className="card">
                <div className="label">Webhooks</div>
                <div className="mono">{preview.webhooks_to_fire.length}</div>
              </div>
              <div className="card">
                <div className="label">Generated agent files</div>
                <div className="dim">{preview.generated_agent_files.join(", ")}</div>
              </div>
            </div>
            {preview.impact && (
              <div className="section" style={{ marginTop: 12 }}>
                <h2>Impact analysis</h2>
                <div className="cards">
                  <div className={`card${preview.impact.level === "high" || preview.impact.level === "critical" ? " alert" : ""}`}>
                    <div className="label">Impact score</div>
                    <div>
                      <span className="mono">{preview.impact.score}/100</span> <StatusBadge status={preview.impact.level} />
                    </div>
                    <div className="dim">{preview.impact.summary}</div>
                  </div>
                  <div className="card">
                    <div className="label">Reported consumers</div>
                    <div className="mono">{preview.impact.manifest_consumers.length}</div>
                    {preview.impact.manifest_consumers.slice(0, 5).map((consumer) => (
                      <div className="dim" key={consumer.id}>{consumer.repo}{consumer.branch ? `@${consumer.branch}` : ""}</div>
                    ))}
                  </div>
                  <div className="card">
                    <div className="label">Dependent specs</div>
                    <div className="mono">{preview.impact.dependent_specs.length}</div>
                    {preview.impact.dependent_specs.slice(0, 5).map((dep) => (
                      <div className="dim" key={`${dep.spec_id}-${dep.relation}`}>{dep.filename} · {dep.relation.replace("_", " ")}</div>
                    ))}
                  </div>
                  <div className="card">
                    <div className="label">Feedback and usage</div>
                    <div className="mono">{preview.impact.feedback.open} open / {preview.impact.feedback.total} total</div>
                    <div className="dim">
                      {(preview.impact.recent_usage.agent_read ?? 0)} reads · {(preview.impact.recent_usage.search ?? 0)} searches ·{" "}
                      {(preview.impact.recent_usage.sync_check ?? 0)} checks
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="toolbar">
          <select value={approvalChannel} onChange={(e) => setApprovalChannel(e.target.value as "stable" | "beta")}>
            <option value="stable">stable</option>
            <option value="beta">beta</option>
          </select>
          <button className="success" onClick={() => decide("approve")}>
            Approve {approvalChannel === "beta" ? "beta" : "& publish"}
          </button>
          <button className="danger" onClick={() => decide("reject")}>
            Reject
          </button>
          <span className="faint">Acting as {getAuthor()}</span>
        </div>
        </>
      )}

      <div className="section">
        <h2>Diff</h2>
        <DiffView diff={review.diff} />
      </div>
    </>
  );
}
