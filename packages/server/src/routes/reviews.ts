import type { FastifyInstance } from "fastify";
import { bumpVersion, type ChangeRequest } from "@specregistry/shared";
import { now, uuid } from "../db.js";
import { HttpError, requireSpec, requireString } from "../helpers.js";
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
    return { ...cr, spec };
  });

  // Approve: bump semver per the requested delta, publish new content, record the version.
  app.post("/reviews/:id/approve", async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reviewedBy = requireString(body, "reviewed_by");
    const cr = requireChangeRequest(app, id);
    if (cr.status !== "pending") throw new HttpError(409, `Change request already ${cr.status}`);
    const spec = requireSpec(app.db, cr.spec_id);
    const newVersion = bumpVersion(spec.current_version, cr.version_delta);
    const ts = now();

    const approve = app.db.transaction(() => {
      app.db
        .prepare(
          `UPDATE change_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ?, resulting_version = ? WHERE id = ?`
        )
        .run(reviewedBy, ts, newVersion, cr.id);
      app.db
        .prepare(
          `UPDATE specs SET content = ?, current_version = ?, status = 'published', updated_by = ?, updated_at = ? WHERE id = ?`
        )
        .run(cr.proposed_content, newVersion, cr.proposed_by, ts, spec.id);
      app.db
        .prepare(
          `INSERT INTO spec_versions (id, spec_id, version, content, published_by, published_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(uuid(), spec.id, newVersion, cr.proposed_content, reviewedBy, ts);
    });
    approve();

    const updated = requireSpec(app.db, spec.id);
    reindexSpec(app.db, updated);
    const queued = enqueueSyncJobs(app.db, updated);
    if (queued > 0 && process.env.GITHUB_TOKEN) {
      // Push-back PRs run in the background; failures land on the job rows.
      void processSyncJobs(app.db, process.env.GITHUB_TOKEN);
    }
    await dispatchWebhooks(
      app.db,
      "review.approved",
      `${updated.filename} v${newVersion} approved by ${reviewedBy}`,
      { change_request_id: cr.id, spec_id: updated.id, filename: updated.filename, version: newVersion }
    );
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
    return requireChangeRequest(app, cr.id);
  });
}
