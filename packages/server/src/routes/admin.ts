import type { FastifyInstance } from "fastify";
import { now, uuid } from "../db.js";
import { HttpError, requireProjectType, requireString } from "../helpers.js";
import { processSyncJobs } from "../lib/github.js";

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // --- Spec templates (conformance) ---

  app.get("/templates", async () => {
    return app.db.prepare("SELECT * FROM spec_templates ORDER BY filename").all();
  });

  app.post("/templates", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const filename = requireString(body, "filename");
    const sections = Array.isArray(body.required_sections) ? body.required_sections : [];
    const duplicate = app.db
      .prepare("SELECT id FROM spec_templates WHERE filename = ? COLLATE NOCASE")
      .get(filename);
    if (duplicate) throw new HttpError(409, `Template already exists for ${filename}`);
    const id = uuid();
    const ts = now();
    app.db
      .prepare(
        `INSERT INTO spec_templates (id, filename, required_sections, content_template, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        filename,
        JSON.stringify(sections),
        (body.content_template as string) ?? "",
        (body.description as string) ?? null,
        ts,
        ts
      );
    reply.code(201);
    return app.db.prepare("SELECT * FROM spec_templates WHERE id = ?").get(id);
  });

  app.put("/templates/:id", async (req) => {
    const { id } = req.params as { id: string };
    const existing = app.db.prepare("SELECT * FROM spec_templates WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) throw new HttpError(404, `Unknown template: ${id}`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    app.db
      .prepare(
        `UPDATE spec_templates SET required_sections = ?, content_template = ?, description = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        Array.isArray(body.required_sections)
          ? JSON.stringify(body.required_sections)
          : (existing.required_sections as string),
        (body.content_template as string) ?? existing.content_template,
        (body.description as string) ?? existing.description,
        now(),
        id
      );
    return app.db.prepare("SELECT * FROM spec_templates WHERE id = ?").get(id);
  });

  app.delete("/templates/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = app.db.prepare("DELETE FROM spec_templates WHERE id = ?").run(id);
    if (result.changes === 0) throw new HttpError(404, `Unknown template: ${id}`);
    reply.code(204);
  });

  // --- Webhooks ---

  app.get("/webhooks", async () => {
    return app.db.prepare("SELECT * FROM webhooks ORDER BY created_at").all();
  });

  app.post("/webhooks", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const url = requireString(body, "url");
    const format = body.format === "slack" ? "slack" : "json";
    const events = Array.isArray(body.events) ? body.events : [];
    const id = uuid();
    app.db
      .prepare("INSERT INTO webhooks (id, url, events, format, active, created_at) VALUES (?, ?, ?, ?, 1, ?)")
      .run(id, url, JSON.stringify(events), format, now());
    reply.code(201);
    return app.db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id);
  });

  app.delete("/webhooks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = app.db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
    if (result.changes === 0) throw new HttpError(404, `Unknown webhook: ${id}`);
    reply.code(204);
  });

  // --- Repo subscriptions (git push-back) ---

  app.get("/subscriptions", async () => {
    return app.db
      .prepare(
        `SELECT rs.*, pt.name AS project_type_name
         FROM repo_subscriptions rs JOIN project_types pt ON pt.id = rs.project_type_id
         ORDER BY rs.created_at`
      )
      .all();
  });

  app.post("/subscriptions", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const repo = requireString(body, "repo");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new HttpError(400, "repo must be in owner/name form");
    const pt = requireProjectType(app.db, requireString(body, "project_type_id"));
    const id = uuid();
    try {
      app.db
        .prepare(
          `INSERT INTO repo_subscriptions (id, project_type_id, repo, branch, base_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          pt.id,
          repo,
          (body.branch as string) || "main",
          (body.base_path as string) || "specs",
          now()
        );
    } catch {
      throw new HttpError(409, `Subscription already exists for ${pt.name} → ${repo}`);
    }
    reply.code(201);
    return app.db.prepare("SELECT * FROM repo_subscriptions WHERE id = ?").get(id);
  });

  app.delete("/subscriptions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    app.db.prepare("DELETE FROM sync_jobs WHERE subscription_id = ?").run(id);
    const result = app.db.prepare("DELETE FROM repo_subscriptions WHERE id = ?").run(id);
    if (result.changes === 0) throw new HttpError(404, `Unknown subscription: ${id}`);
    reply.code(204);
  });

  app.get("/sync-jobs", async () => {
    return app.db
      .prepare(
        `SELECT sj.*, rs.repo, rs.branch, s.filename
         FROM sync_jobs sj
         JOIN repo_subscriptions rs ON rs.id = sj.subscription_id
         JOIN specs s ON s.id = sj.spec_id
         ORDER BY sj.created_at DESC LIMIT 100`
      )
      .all();
  });

  app.post("/sync-jobs/run", async () => {
    const results = await processSyncJobs(app.db, process.env.GITHUB_TOKEN);
    return { processed: results.length, results };
  });

  // --- Usage analytics ---

  app.get("/analytics/summary", async () => {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const counts = app.db
      .prepare(
        "SELECT event_type, COUNT(*) AS n FROM usage_events WHERE created_at >= ? GROUP BY event_type"
      )
      .all(since) as Array<{ event_type: string; n: number }>;
    const byType = Object.fromEntries(counts.map((c) => [c.event_type, c.n]));

    const topTypes = app.db
      .prepare(
        `SELECT pt.name, COUNT(*) AS n
         FROM usage_events ue JOIN project_types pt ON pt.id = ue.project_type_id
         WHERE ue.created_at >= ? AND ue.project_type_id IS NOT NULL
         GROUP BY pt.id ORDER BY n DESC LIMIT 5`
      )
      .all(since);

    // "Stale but load-bearing": published, untouched for 90+ days, in a type that's still queried.
    const staleCutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    const stale = app.db
      .prepare(
        `SELECT s.id, s.filename, s.current_version, s.updated_at, pt.name AS project_type_name
         FROM specs s JOIN project_types pt ON pt.id = s.project_type_id
         WHERE s.status = 'published' AND s.updated_at < ?
         ORDER BY s.updated_at LIMIT 10`
      )
      .all(staleCutoff);

    return { window_days: 30, events: byType, top_project_types: topTypes, stale_specs: stale };
  });
}
