import type { FastifyInstance } from "fastify";
import { now, uuid } from "../db.js";
import { actorFrom, recordAudit } from "../lib/auditLog.js";
import { HttpError, requireString } from "../helpers.js";

type RiskLevel = "safe" | "restricted";
type SkillStatus = "active" | "disabled";

function slugValue(value: unknown): string {
  const slug = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new HttpError(400, "skill slug is required");
  if (slug.length > 80) throw new HttpError(400, "skill slug must be 80 characters or fewer");
  return slug;
}

function riskValue(value: unknown, fallback: RiskLevel = "safe"): RiskLevel {
  const risk = value ?? fallback;
  if (risk !== "safe" && risk !== "restricted") throw new HttpError(400, "risk_level must be safe or restricted");
  return risk;
}

function statusValue(value: unknown, fallback: SkillStatus = "active"): SkillStatus {
  const status = value ?? fallback;
  if (status !== "active" && status !== "disabled") throw new HttpError(400, "status must be active or disabled");
  return status;
}

function bounded(value: string, field: string, max: number): string {
  if (value.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer`);
  return value;
}

export async function skillRoutes(app: FastifyInstance): Promise<void> {
  app.get("/skills", async (req) => {
    const { include_disabled } = req.query as { include_disabled?: string };
    if (include_disabled === "true" && req.user && req.user.role !== "admin") {
      throw new HttpError(403, "Admin role required to view disabled skills");
    }
    return app.db
      .prepare(`SELECT * FROM agent_skills ${include_disabled === "true" ? "" : "WHERE status = 'active'"} ORDER BY built_in DESC, name`)
      .all();
  });

  app.post("/skills", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = uuid();
    const slug = slugValue(body.slug ?? body.name);
    const name = bounded(requireString(body, "name"), "name", 120);
    const description = bounded(requireString(body, "description"), "description", 500);
    const instructions = bounded(requireString(body, "instructions"), "instructions", 20000);
    const risk = riskValue(body.risk_level);
    const status = statusValue(body.status);
    if (app.db.prepare("SELECT id FROM agent_skills WHERE slug = ?").get(slug)) {
      throw new HttpError(409, `Agent skill already exists: ${slug}`);
    }
    const ts = now();
    app.db.prepare(
      `INSERT INTO agent_skills (id, slug, name, description, instructions, risk_level, status, built_in, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(id, slug, name, description, instructions, risk, status, ts, ts);
    recordAudit(app.db, { actor: actorFrom(req, "settings"), action: "skill.created", target_type: "agent_skill", target_id: id, summary: `Agent skill created: ${name}`, detail: { slug, risk_level: risk, status } });
    reply.code(201);
    return app.db.prepare("SELECT * FROM agent_skills WHERE id = ?").get(id);
  });

  app.put("/skills/:id", async (req) => {
    const { id } = req.params as { id: string };
    const existing = app.db.prepare("SELECT * FROM agent_skills WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!existing) throw new HttpError(404, `Unknown agent skill: ${id}`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = bounded(typeof body.name === "string" && body.name.trim() ? body.name.trim() : String(existing.name), "name", 120);
    const description = bounded(typeof body.description === "string" && body.description.trim() ? body.description.trim() : String(existing.description), "description", 500);
    const instructions = bounded(typeof body.instructions === "string" && body.instructions.trim() ? body.instructions.trim() : String(existing.instructions), "instructions", 20000);
    const risk = riskValue(body.risk_level, existing.risk_level as RiskLevel);
    const status = statusValue(body.status, existing.status as SkillStatus);
    app.db.prepare("UPDATE agent_skills SET name = ?, description = ?, instructions = ?, risk_level = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(name, description, instructions, risk, status, now(), id);
    recordAudit(app.db, { actor: actorFrom(req, "settings"), action: "skill.updated", target_type: "agent_skill", target_id: id, summary: `Agent skill updated: ${name}`, detail: { slug: existing.slug, risk_level: risk, status } });
    return app.db.prepare("SELECT * FROM agent_skills WHERE id = ?").get(id);
  });

  app.delete("/skills/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = app.db.prepare("SELECT * FROM agent_skills WHERE id = ?").get(id) as { name: string; built_in: number } | undefined;
    if (!existing) throw new HttpError(404, `Unknown agent skill: ${id}`);
    if (existing.built_in) throw new HttpError(409, "Built-in skills can be disabled but not deleted");
    app.db.prepare("DELETE FROM agent_skills WHERE id = ?").run(id);
    recordAudit(app.db, { actor: actorFrom(req, "settings"), action: "skill.deleted", target_type: "agent_skill", target_id: id, summary: `Agent skill deleted: ${existing.name}` });
    reply.code(204).send();
  });
}
