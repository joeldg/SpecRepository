import type { FastifyInstance } from "fastify";
import { bumpVersion, type ChangeRequest } from "@specregistry/shared";
import { now, uuid } from "../db.js";
import { HttpError, requireSpec, requireString } from "../helpers.js";
import { approvalCount, policyForSpec, policyReviewers, requiredApprovalCount } from "../lib/approvalPolicies.js";
import { enforceRequiredReviewers } from "../lib/auth.js";
import { actorFrom, recordAudit } from "../lib/auditLog.js";
import { dispatchWebhooks } from "../lib/events.js";
import { enqueueSyncJobs, processSyncJobs } from "../lib/github.js";
import { reindexSpec } from "../lib/search.js";

function requireChangeRequest(app: FastifyInstance, id: string): ChangeRequest {
  const cr = app.db.prepare("SELECT * FROM change_requests WHERE id = ?").get(id) as
    | ChangeRequest
    | undefined;
  if (!cr) throw new HttpError(404, `Unknown change request: ${id}`);
  return cr;
}

export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  app.get("/reviews", async (req) => {
    const { status } = req.query as { status?: string };
    const base = `
      SELECT cr.*, s.filename, s.current_version, s.project_type_id, pt.name AS project_type_name
      FROM change_requests cr
      JOIN specs s ON s.id = cr.spec_id
      JOIN project_types pt ON pt.id = s.project_type_id
    `;
    if (status) {
      return app.db.prepare(`${base} WHERE cr.status = ? ORDER BY cr.created_at DESC`).all(status);
    }
    return app.db.prepare(`${base} ORDER BY cr.created_at DESC`).all();
  });

  app.get("/reviews/:id", async (req) => {
    const { id } = req.params as { id: string };
    const cr = requireChangeRequest(app, id);
    const spec = requireSpec(app.db, cr.spec_id);
    const approvals = app.db
      .prepare("SELECT reviewer, created_at FROM review_approvals WHERE change_request_id = ? ORDER BY created_at")
      .all(cr.id);
    const policy = policyForSpec(app.db, spec);
    return {
      ...cr,
      spec,
      approvals,
      approval_count: approvalCount(app.db, cr.id),
      required_approvals: requiredApprovalCount(app.db, spec),
      approval_policy: policy
        ? {
            id: policy.id,
            filename_glob: policy.filename_glob,
            min_approvals: policy.min_approvals,
            required_reviewers: JSON.parse(policy.required_reviewers) as string[],
          }
        : null,
    };
  });

  // Approve: bump semver per the requested delta, publish new content, record the version.
  // channel="beta" records a prerelease version without touching the stable head.
  app.post("/reviews/:id/approve", async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reviewedBy = requireString(body, "reviewed_by");
    const channel = body.channel === "beta" ? "beta" : "stable";
    const cr = requireChangeRequest(app, id);
    if (cr.status !== "pending") throw new HttpError(409, `Change request already ${cr.status}`);
    const spec = requireSpec(app.db, cr.spec_id);
    enforceRequiredReviewers(app.db, spec.project_type_id, reviewedBy, req);
    const policyRequired = policyReviewers(app.db, spec);
    if (
      policyRequired.length > 0 &&
      req.user?.role !== "admin" &&
      !policyRequired.some((r) => r.toLowerCase() === (req.user?.username ?? reviewedBy).toLowerCase())
    ) {
      throw new HttpError(403, `This spec requires review by one of: ${policyRequired.join(", ")}`);
    }
    try {
      app.db
        .prepare("INSERT INTO review_approvals (id, change_request_id, reviewer, created_at) VALUES (?, ?, ?, ?)")
        .run(uuid(), cr.id, reviewedBy, now());
    } catch {
      throw new HttpError(409, `Reviewer has already approved this change request: ${reviewedBy}`);
    }
    const approvals = approvalCount(app.db, cr.id);
    const requiredApprovals = requiredApprovalCount(app.db, spec);
    recordAudit(app.db, {
      actor: actorFrom(req, reviewedBy),
      action: "review.approval_recorded",
      target_type: "change_request",
      target_id: cr.id,
      summary: `${reviewedBy} approved ${spec.filename} (${approvals}/${requiredApprovals})`,
      detail: { filename: spec.filename, channel, approvals, required_approvals: requiredApprovals },
    });
    if (approvals < requiredApprovals) {
      await dispatchWebhooks(
        app.db,
        "review.approval_recorded",
        `${spec.filename}: approval ${approvals}/${requiredApprovals} recorded by ${reviewedBy}`,
        { change_request_id: cr.id, spec_id: spec.id, filename: spec.filename, approvals, required_approvals: requiredApprovals }
      );
      return { ...requireChangeRequest(app, cr.id), approval_count: approvals, required_approvals: requiredApprovals };
    }
    const bumped = bumpVersion(spec.current_version, cr.version_delta);
    let newVersion = bumped;
    if (channel === "beta") {
      const priorBetas = app.db
        .prepare("SELECT COUNT(*) AS n FROM spec_versions WHERE spec_id = ? AND version LIKE ?")
        .get(spec.id, `${bumped}-beta.%`) as { n: number };
      newVersion = `${bumped}-beta.${priorBetas.n + 1}`;
    }
    const ts = now();

    const approve = app.db.transaction(() => {
      app.db
        .prepare(
          `UPDATE change_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ?, resulting_version = ? WHERE id = ?`
        )
        .run(reviewedBy, ts, newVersion, cr.id);
      if (channel === "stable") {
        app.db
          .prepare(
            `UPDATE specs SET content = ?, current_version = ?, status = 'published', updated_by = ?, updated_at = ? WHERE id = ?`
          )
          .run(cr.proposed_content, newVersion, cr.proposed_by, ts, spec.id);
      } else {
        // The stable head is untouched; the spec leaves pending_review.
        app.db.prepare("UPDATE specs SET status = 'published', updated_at = ? WHERE id = ?").run(ts, spec.id);
      }
      app.db
        .prepare(
          `INSERT INTO spec_versions (id, spec_id, version, content, published_by, published_at, channel)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(uuid(), spec.id, newVersion, cr.proposed_content, reviewedBy, ts, channel);
    });
    approve();

    const updated = requireSpec(app.db, spec.id);
    if (channel === "stable") {
      reindexSpec(app.db, updated);
      const queued = enqueueSyncJobs(app.db, updated);
      if (queued > 0 && process.env.GITHUB_TOKEN) {
        // Push-back PRs run in the background; failures land on the job rows.
        void processSyncJobs(app.db, process.env.GITHUB_TOKEN);
      }
    }
    await dispatchWebhooks(
      app.db,
      "review.approved",
      `${updated.filename} v${newVersion}${channel === "beta" ? " (beta)" : ""} approved by ${reviewedBy}`,
      { change_request_id: cr.id, spec_id: updated.id, filename: updated.filename, version: newVersion, channel }
    );
    recordAudit(app.db, {
      actor: actorFrom(req, reviewedBy),
      action: "review.published",
      target_type: "change_request",
      target_id: cr.id,
      summary: `${updated.filename} published as ${newVersion}`,
      detail: { spec_id: updated.id, filename: updated.filename, version: newVersion, channel },
    });
    return requireChangeRequest(app, cr.id);
  });

  // Reject: the spec returns to its previous published state untouched.
  app.post("/reviews/:id/reject", async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reviewedBy = requireString(body, "reviewed_by");
    const cr = requireChangeRequest(app, id);
    if (cr.status !== "pending") throw new HttpError(409, `Change request already ${cr.status}`);
    const ts = now();

    const reject = app.db.transaction(() => {
      app.db
        .prepare(
          `UPDATE change_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?`
        )
        .run(reviewedBy, ts, cr.id);
      // Only restore published status if no other pending change requests remain.
      const remaining = app.db
        .prepare("SELECT COUNT(*) AS n FROM change_requests WHERE spec_id = ? AND status = 'pending'")
        .get(cr.spec_id) as { n: number };
      if (remaining.n === 0) {
        app.db.prepare("UPDATE specs SET status = 'published', updated_at = ? WHERE id = ?").run(ts, cr.spec_id);
      }
    });
    reject();
    const spec = requireSpec(app.db, cr.spec_id);
    await dispatchWebhooks(app.db, "review.rejected", `${spec.filename}: change rejected by ${reviewedBy}`, {
      change_request_id: cr.id,
      spec_id: spec.id,
      filename: spec.filename,
    });
    recordAudit(app.db, {
      actor: actorFrom(req, reviewedBy),
      action: "review.rejected",
      target_type: "change_request",
      target_id: cr.id,
      summary: `${spec.filename} change rejected by ${reviewedBy}`,
      detail: { spec_id: spec.id, filename: spec.filename },
    });
    return requireChangeRequest(app, cr.id);
  });
}
