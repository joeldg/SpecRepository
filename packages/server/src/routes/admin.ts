import type { FastifyInstance } from "fastify";
import { now, uuid } from "../db.js";
import { HttpError, requireProjectType, requireString } from "../helpers.js";
import {
  getLdapConfig,
  ldapAuthenticate,
  mapLdapGroupsToRole,
  publicLdapConfig,
  saveLdapConfig,
  type LdapConfig,
} from "../lib/auth.js";
import { actorFrom, recordAudit } from "../lib/auditLog.js";
import { processSyncJobs } from "../lib/github.js";
import { listLlmModels, publicLlmConfig, runLlmText, saveLlmConfig, type LlmConfig } from "../lib/llm.js";
import { getAppKeyConfig, publicAppKeyConfig, saveAppKeyConfig, type AppKeyConfig } from "../lib/appKeys.js";

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // --- App keys / integration secrets ---

  app.get("/app-keys", async () => {
    return publicAppKeyConfig(app.db);
  });

  app.put("/app-keys", async (req) => {
    const body = (req.body ?? {}) as Partial<AppKeyConfig> & {
      clear_github_token?: boolean;
      clear_github_webhook_secret?: boolean;
      clear_slack_signing_secret?: boolean;
    };
    const saved = publicAppKeyConfig(app.db, saveAppKeyConfig(app.db, body));
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "app_keys.updated",
      target_type: "app_keys",
      summary: "App keys updated",
      detail: { ...saved },
    });
    return saved;
  });

  // --- LLM provider settings ---

  app.get("/llm/config", async () => {
    return publicLlmConfig(app.db);
  });

  app.put("/llm/config", async (req) => {
    const body = (req.body ?? {}) as Partial<LlmConfig> & { clear_api_key?: boolean };
    const saved = publicLlmConfig(app.db, saveLlmConfig(app.db, body));
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "llm.config.updated",
      target_type: "llm",
      summary: "LLM configuration updated",
      detail: { provider: saved.provider, model: saved.model, base_url: saved.base_url, has_api_key: saved.has_api_key },
    });
    return saved;
  });

  app.post("/llm/test", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : "Reply with: ok";
    const maxTokens = Math.max(1, Math.min(100000, Number(body.max_tokens ?? 200) || 200));
    const result = await runLlmText(app.db, {
      system: "You are a connectivity test for SpecRegistry. Reply briefly.",
      user: prompt,
      maxTokens,
    });
    return { ok: true, provider: result.provider, model: result.model, text: result.text, max_tokens: maxTokens };
  });

  app.get("/llm/models", async () => {
    return listLlmModels(app.db);
  });

  // --- LDAP settings ---

  app.get("/ldap/config", async () => {
    return publicLdapConfig(app.db);
  });

  app.put("/ldap/config", async (req) => {
    const body = (req.body ?? {}) as Partial<LdapConfig> & { clear_bind_password?: boolean };
    const saved = publicLdapConfig(app.db, saveLdapConfig(app.db, body));
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "ldap.config.updated",
      target_type: "ldap",
      summary: "LDAP configuration updated",
      detail: { enabled: saved.enabled, url: saved.url, default_role: saved.default_role },
    });
    return saved;
  });

  app.post("/ldap/role-preview", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const groups = Array.isArray(body.groups) ? body.groups.map(String) : [];
    return { role: mapLdapGroupsToRole(groups, getLdapConfig(app.db)), groups };
  });

  app.post("/ldap/test", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = requireString(body, "username");
    const password = requireString(body, "password");
    const result = await ldapAuthenticate(app.db, username, password);
    return {
      ok: true,
      username,
      dn: result.dn,
      display_name: result.displayName ?? null,
      groups: result.groups,
      role: result.role,
    };
  });

  // --- Approval policies ---

  app.get("/approval-policies", async () => {
    return app.db
      .prepare(
        `SELECT ap.*, pt.name AS project_type_name
         FROM approval_policies ap LEFT JOIN project_types pt ON pt.id = ap.project_type_id
         ORDER BY pt.name, ap.filename_glob`
      )
      .all();
  });

  app.post("/approval-policies", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = uuid();
    const ts = now();
    const projectTypeId =
      typeof body.project_type_id === "string" && body.project_type_id ? requireProjectType(app.db, body.project_type_id).id : null;
    const reviewers = Array.isArray(body.required_reviewers) ? body.required_reviewers.map(String) : [];
    app.db
      .prepare(
        `INSERT INTO approval_policies
           (id, project_type_id, filename_glob, min_approvals, required_reviewers, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        projectTypeId,
        (body.filename_glob as string) || "*",
        Math.max(1, Number(body.min_approvals ?? 1)),
        JSON.stringify(reviewers),
        ts,
        ts
      );
    reply.code(201);
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "approval_policy.created",
      target_type: "approval_policy",
      target_id: id,
      summary: `Approval policy created for ${(body.filename_glob as string) || "*"}`,
      detail: { project_type_id: projectTypeId, min_approvals: Math.max(1, Number(body.min_approvals ?? 1)) },
    });
    return app.db.prepare("SELECT * FROM approval_policies WHERE id = ?").get(id);
  });

  app.delete("/approval-policies/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = app.db.prepare("DELETE FROM approval_policies WHERE id = ?").run(id);
    if (result.changes === 0) throw new HttpError(404, `Unknown approval policy: ${id}`);
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "approval_policy.deleted",
      target_type: "approval_policy",
      target_id: id,
      summary: "Approval policy deleted",
    });
    reply.code(204);
  });

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
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "template.created",
      target_type: "template",
      target_id: id,
      summary: `Template created for ${filename}`,
    });
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
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "template.updated",
      target_type: "template",
      target_id: id,
      summary: `Template updated for ${existing.filename as string}`,
    });
    return app.db.prepare("SELECT * FROM spec_templates WHERE id = ?").get(id);
  });

  app.delete("/templates/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = app.db.prepare("DELETE FROM spec_templates WHERE id = ?").run(id);
    if (result.changes === 0) throw new HttpError(404, `Unknown template: ${id}`);
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "template.deleted",
      target_type: "template",
      target_id: id,
      summary: "Template deleted",
    });
    reply.code(204);
  });

  // --- Webhooks ---

  app.get("/webhooks", async () => {
    return app.db.prepare("SELECT * FROM webhooks ORDER BY created_at").all();
  });

  app.post("/webhooks", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const url = requireString(body, "url");
    const format = body.format === "slack" || body.format === "gchat" ? body.format : "json";
    const events = Array.isArray(body.events) ? body.events : [];
    const id = uuid();
    app.db
      .prepare("INSERT INTO webhooks (id, url, events, format, active, created_at) VALUES (?, ?, ?, ?, 1, ?)")
      .run(id, url, JSON.stringify(events), format, now());
    reply.code(201);
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "webhook.created",
      target_type: "webhook",
      target_id: id,
      summary: `Webhook created (${format})`,
      detail: { events },
    });
    return app.db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id);
  });

  app.delete("/webhooks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = app.db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
    if (result.changes === 0) throw new HttpError(404, `Unknown webhook: ${id}`);
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "webhook.deleted",
      target_type: "webhook",
      target_id: id,
      summary: "Webhook deleted",
    });
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
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "subscription.created",
      target_type: "subscription",
      target_id: id,
      summary: `Repo subscription created for ${repo}`,
      detail: { project_type: pt.name },
    });
    return app.db.prepare("SELECT * FROM repo_subscriptions WHERE id = ?").get(id);
  });

  app.delete("/subscriptions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    app.db.prepare("DELETE FROM sync_jobs WHERE subscription_id = ?").run(id);
    const result = app.db.prepare("DELETE FROM repo_subscriptions WHERE id = ?").run(id);
    if (result.changes === 0) throw new HttpError(404, `Unknown subscription: ${id}`);
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "subscription.deleted",
      target_type: "subscription",
      target_id: id,
      summary: "Repo subscription deleted",
    });
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

  app.post("/sync-jobs/run", async (req) => {
    const results = await processSyncJobs(app.db, getAppKeyConfig(app.db).github_token);
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "sync_jobs.run",
      target_type: "sync_jobs",
      summary: `Processed ${results.length} sync jobs`,
    });
    return { processed: results.length, results };
  });

  // --- Audit log ---

  app.get("/audit-log", async (req) => {
    const { limit } = req.query as { limit?: string };
    return app.db
      .prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?")
      .all(Math.min(200, Math.max(1, Number(limit ?? 100))));
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

  app.get("/reports/overview", async () => {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const staleCutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();

    const scopeRows = app.db
      .prepare(
        `SELECT
           CASE WHEN s.project_id IS NOT NULL THEN 'project' ELSE pt.scope END AS scope,
           s.status,
           COUNT(*) AS n
         FROM specs s
         JOIN project_types pt ON pt.id = s.project_type_id
         GROUP BY scope, s.status`
      )
      .all() as Array<{ scope: string; status: string; n: number }>;

    const feedbackByType = app.db
      .prepare("SELECT error_type, status, COUNT(*) AS n FROM agent_feedback GROUP BY error_type, status")
      .all() as Array<{ error_type: string; status: string; n: number }>;

    const projectTypes = app.db
      .prepare(
        `SELECT pt.id, pt.name, pt.scope, pt.industry,
                COUNT(DISTINCT CASE WHEN s.project_id IS NULL THEN s.id END) AS spec_count,
                COUNT(DISTINCT CASE WHEN s.status = 'published' AND s.project_id IS NULL THEN s.id END) AS published_specs,
                COUNT(DISTINCT CASE WHEN s.project_id IS NOT NULL THEN s.id END) AS project_spec_count,
                COUNT(DISTINCT rc.id) AS project_count,
                COUNT(DISTINCT CASE WHEN af.status = 'open' THEN af.id END) AS open_feedback,
                COUNT(DISTINCT af.id) AS feedback_total,
                COUNT(DISTINCT CASE WHEN cr.status = 'pending' THEN cr.id END) AS pending_reviews,
                COUNT(DISTINCT CASE WHEN s.status = 'published' AND s.updated_at < ? THEN s.id END) AS stale_specs,
                COUNT(DISTINCT er.id) AS efficacy_runs,
                COUNT(DISTINCT CASE WHEN er.improved = 1 THEN er.id END) AS efficacy_improved
         FROM project_types pt
         LEFT JOIN specs s ON s.project_type_id = pt.id
         LEFT JOIN repo_consumers rc ON rc.project_type_id = pt.id
         LEFT JOIN agent_feedback af ON af.spec_id = s.id
         LEFT JOIN change_requests cr ON cr.spec_id = s.id
         LEFT JOIN efficacy_runs er ON er.spec_id = s.id
         GROUP BY pt.id
         ORDER BY pt.scope = 'global' DESC, pt.name`
      )
      .all(staleCutoff);

    const usageRows = app.db
      .prepare(
        `SELECT pt.id AS project_type_id, ue.event_type, COUNT(*) AS n
         FROM usage_events ue
         JOIN project_types pt ON pt.id = ue.project_type_id
         WHERE ue.created_at >= ?
         GROUP BY pt.id, ue.event_type`
      )
      .all(since) as Array<{ project_type_id: string; event_type: string; n: number }>;
    const usageByType = new Map<string, Record<string, number>>();
    for (const row of usageRows) {
      usageByType.set(row.project_type_id, {
        ...(usageByType.get(row.project_type_id) ?? {}),
        [row.event_type]: row.n,
      });
    }

    const projects = app.db
      .prepare(
        `SELECT rc.id, rc.repo, rc.branch, rc.project_type_id, pt.name AS project_type_name,
                rc.specs_path, rc.manifest_path, rc.last_seen_at,
                COUNT(DISTINCT rcs.filename) AS reported_specs,
                COUNT(DISTINCT ps.id) AS project_specs,
                COUNT(DISTINCT CASE WHEN af.status = 'open' THEN af.id END) AS open_feedback,
                COUNT(DISTINCT af.id) AS feedback_total,
                COUNT(DISTINCT CASE WHEN cr.status = 'pending' THEN cr.id END) AS pending_reviews,
                COUNT(DISTINCT CASE
                  WHEN s.status = 'published'
                   AND (s.project_id = rc.id OR (s.project_id IS NULL AND (s.project_type_id = rc.project_type_id OR s.project_type_id IN (SELECT id FROM project_types WHERE scope = 'global'))))
                   AND (rcs.version IS NULL OR rcs.version != s.current_version)
                  THEN s.id
                END) AS outdated_specs
         FROM repo_consumers rc
         JOIN project_types pt ON pt.id = rc.project_type_id
         LEFT JOIN repo_consumer_specs rcs ON rcs.consumer_id = rc.id
         LEFT JOIN specs ps ON ps.project_id = rc.id
         LEFT JOIN specs s ON s.project_id = rc.id OR (s.project_id IS NULL AND (s.project_type_id = rc.project_type_id OR s.project_type_id IN (SELECT id FROM project_types WHERE scope = 'global')))
         LEFT JOIN agent_feedback af ON af.spec_id = ps.id
         LEFT JOIN change_requests cr ON cr.spec_id = ps.id
         GROUP BY rc.id
         ORDER BY rc.last_seen_at DESC, rc.repo`
      )
      .all();

    const globalSpecs = app.db
      .prepare(
        `SELECT s.id, s.filename, s.current_version, s.status, s.updated_at,
                COUNT(DISTINCT CASE WHEN af.status = 'open' THEN af.id END) AS open_feedback,
                COUNT(DISTINCT af.id) AS feedback_total,
                COUNT(DISTINCT CASE WHEN cr.status = 'pending' THEN cr.id END) AS pending_reviews,
                COUNT(DISTINCT er.id) AS efficacy_runs,
                COUNT(DISTINCT CASE WHEN er.improved = 1 THEN er.id END) AS efficacy_improved
         FROM specs s
         JOIN project_types pt ON pt.id = s.project_type_id
         LEFT JOIN agent_feedback af ON af.spec_id = s.id
         LEFT JOIN change_requests cr ON cr.spec_id = s.id
         LEFT JOIN efficacy_runs er ON er.spec_id = s.id
         WHERE pt.scope = 'global' AND s.project_id IS NULL
         GROUP BY s.id
         ORDER BY s.filename`
      )
      .all();

    return {
      generated_at: now(),
      window_days: 30,
      scopes: scopeRows,
      feedback_by_type: feedbackByType,
      project_types: projectTypes.map((row: any) => ({ ...row, usage: usageByType.get(row.id) ?? {} })),
      projects,
      global_specs: globalSpecs,
    };
  });
}
