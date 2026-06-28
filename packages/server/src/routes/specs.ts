import type { FastifyInstance, FastifyRequest } from "fastify";
import AdmZip from "adm-zip";
import type { Spec, SpecVersion, VersionDelta } from "@specregistry/shared";
import { now, uuid } from "../db.js";
import { auditPromptForSpec } from "../lib/specAutomation.js";
import {
  HttpError,
  findProjectType,
  findProjectConsumer,
  requireOneOf,
  requireProjectConsumer,
  requireProjectType,
  requireSpec,
  requireString,
} from "../helpers.js";
import { createChangeRequest } from "../lib/changes.js";
import { mcpConfig, mcpSkillMarkdown } from "../lib/agentPack.js";
import { actorFrom, recordAudit } from "../lib/auditLog.js";
import { publicUrl } from "../lib/publicUrl.js";
import { bundleSpecs, compileBundle, type CompileTarget } from "../lib/compile.js";
import { dispatchWebhooks, recordUsage } from "../lib/events.js";
import { enqueueSyncJobs } from "../lib/github.js";
import { lintContent } from "../lib/lint.js";
import { dependencyMap } from "../lib/dependencies.js";
import { reindexSpecSearch } from "../lib/search.js";
import { sha256, signManifest } from "../lib/sign.js";
import { reviewImpact } from "../lib/reviewImpact.js";
import { migrationChecklist, specChangeSummaryMarkdown } from "../lib/specChangeSummary.js";
import { renderSkillMarkdown, type AgentSkillRecord } from "../lib/skills.js";

const SUMMARY_SELECT = `
  SELECT s.id, s.project_type_id, s.project_id, s.filename, s.current_version, s.status,
         s.updated_by, s.created_at, s.updated_at, s.deleted_at,
         pt.name AS project_type_name, pt.scope AS project_type_scope,
         rc.repo AS project_name,
         CASE WHEN s.project_id IS NOT NULL THEN 'project' ELSE pt.scope END AS effective_scope,
         (SELECT COUNT(*) FROM agent_feedback f WHERE f.spec_id = s.id AND f.status = 'open') AS open_feedback_count,
         (SELECT COUNT(*) FROM change_requests cr WHERE cr.spec_id = s.id AND cr.status = 'pending') AS pending_review_count
  FROM specs s
  JOIN project_types pt ON pt.id = s.project_type_id
  LEFT JOIN repo_consumers rc ON rc.id = s.project_id
`;

function projectFromQuery(
  app: FastifyInstance,
  ptId: string,
  query: { project_id?: string; repo?: string }
) {
  return query.project_id
    ? requireProjectConsumer(app.db, query.project_id, ptId)
    : query.repo
      ? findProjectConsumer(app.db, query.repo, ptId)
      : undefined;
}

export async function specRoutes(app: FastifyInstance): Promise<void> {
  // Agent-role tokens may only create/edit/publish project-scoped specs bound to
  // their own enrolled repo. Humans (author+) and anonymous dev access are
  // unrestricted here; governed (global / project-type) specs require human review.
  function assertAgentScope(req: FastifyRequest, projectId: string | null, action: string): void {
    const user = req.user;
    if (!user || user.role !== "agent") return;
    if (!projectId) {
      throw new HttpError(
        403,
        `Agents may only ${action} project-scoped specs for their own repo. Global and project-type specs require a human-reviewed change (use the review workflow); do not self-publish governed specs.`
      );
    }
    const consumer = app.db.prepare("SELECT repo FROM repo_consumers WHERE id = ?").get(projectId) as
      | { repo: string }
      | undefined;
    if (!consumer || (user.repo ?? "").toLowerCase() !== consumer.repo.toLowerCase()) {
      throw new HttpError(403, `This agent is enrolled for ${user.repo ?? "(none)"} and cannot ${action} another project's specs.`);
    }
  }

  // List all global and project-type specs (summaries, no markdown body).
  app.get("/specs", async (req) => {
    const { project_type_id, project_id } = req.query as { project_type_id?: string; project_id?: string };
    if (project_id) {
      const project = requireProjectConsumer(app.db, project_id);
      return app.db
        .prepare(`${SUMMARY_SELECT} WHERE s.deleted_at IS NULL AND (s.project_id = ? OR (s.project_id IS NULL AND (s.project_type_id = ? OR pt.scope = 'global'))) ORDER BY CASE effective_scope WHEN 'global' THEN 0 WHEN 'project_type' THEN 1 ELSE 2 END, s.filename`)
        .all(project.id, project.project_type_id);
    }
    if (project_type_id) {
      return app.db
        .prepare(`${SUMMARY_SELECT} WHERE s.deleted_at IS NULL AND s.project_type_id = ? ORDER BY s.filename`)
        .all(project_type_id);
    }
    return app.db
      .prepare(`${SUMMARY_SELECT} WHERE s.deleted_at IS NULL ORDER BY pt.scope = 'global' DESC, pt.name, s.filename`)
      .all();
  });

  app.get("/specs/dependency-map", async (req) => {
    const { project_type_id, project_id } = req.query as { project_type_id?: string; project_id?: string };
    if (project_id) requireProjectConsumer(app.db, project_id);
    return dependencyMap(app.db, project_type_id, project_id);
  });

  app.get("/specs/:key/impact", async (req) => {
    const { key } = req.params as { key: string };
    const { delta } = req.query as { delta?: string };
    const versionDelta = delta === "major" || delta === "minor" || delta === "patch" ? delta : "minor";
    const spec = requireSpec(app.db, key);
    return {
      spec,
      impact: reviewImpact(app.db, spec, versionDelta),
      migration_checklist: migrationChecklist(app.db, spec, versionDelta),
      pr_summary_markdown: specChangeSummaryMarkdown(app.db, spec, versionDelta),
    };
  });

  // Zipped folder of the latest published specs for a project type (+ all global specs).
  // ?channel=beta overlays the newest beta versions; the manifest is ed25519-signed.
  app.get("/specs/:key/download", async (req, reply) => {
    const { key } = req.params as { key: string };
    const { channel, project_id, repo } = req.query as { channel?: string; project_id?: string; repo?: string };
    const pt = requireProjectType(app.db, key);
    const project = project_id ? requireProjectConsumer(app.db, project_id, pt.id) : repo ? findProjectConsumer(app.db, repo, pt.id) : undefined;
    const specs = bundleSpecs(app.db, pt.id, channel ?? "stable", project?.id);
    if (specs.length === 0) throw new HttpError(404, `No published specs for: ${pt.name}`);

    const zip = new AdmZip();
    // Project-type specs are added last so they win over a same-named global spec.
    for (const spec of specs) {
      zip.addFile(spec.filename, Buffer.from(spec.content, "utf8"));
    }
    const manifest = signManifest(app.db, {
      project_type: pt.name,
      project: project?.repo ?? null,
      channel: channel ?? "stable",
      fetched_at: now(),
      specs: specs.map((s) => ({
        filename: s.filename,
        version: s.current_version,
        project_type: s.project_id ? project?.repo ?? "Project" : s.project_type_id === pt.id ? pt.name : "Global",
        scope: s.project_id ? "project" : s.project_type_id === pt.id ? "project_type" : "global",
        sha256: sha256(s.content),
      })),
    });
    zip.addFile(".specregistry.json", Buffer.from(JSON.stringify(manifest, null, 2)));

    recordUsage(app.db, "download", pt.id);
    reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${pt.name.replace(/[^\w.-]+/g, "_")}-specs.zip"`);
    return zip.toBuffer();
  });

  // Full spec detail with version history, change requests, and feedback.
  app.get("/specs/:key", async (req) => {
    const { key } = req.params as { key: string };
    const spec = requireSpec(app.db, key);
    const versions = app.db
      .prepare("SELECT * FROM spec_versions WHERE spec_id = ? ORDER BY published_at DESC")
      .all(spec.id) as SpecVersion[];
    const change_requests = app.db
      .prepare("SELECT * FROM change_requests WHERE spec_id = ? ORDER BY created_at DESC")
      .all(spec.id);
    const feedback = app.db
      .prepare("SELECT * FROM agent_feedback WHERE spec_id = ? ORDER BY created_at DESC")
      .all(spec.id);
    const efficacy_runs = app.db
      .prepare("SELECT * FROM efficacy_runs WHERE spec_id = ? ORDER BY created_at DESC")
      .all(spec.id);
    return { ...spec, versions, change_requests, feedback, efficacy_runs };
  });

  // Create a new draft spec (0.1.0). Publishing records the first immutable version.
  app.post("/specs", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectTypeId = requireString(body, "project_type_id");
    const projectId = typeof body.project_id === "string" && body.project_id ? body.project_id : null;
    const filename = requireString(body, "filename");
    const updatedBy = requireString(body, "updated_by");
    const content = typeof body.content === "string" ? body.content : "";
    const pt = findProjectType(app.db, projectTypeId);
    if (!pt) throw new HttpError(404, `Unknown project type: ${projectTypeId}`);
    const project = projectId ? requireProjectConsumer(app.db, projectId, pt.id) : undefined;
    assertAgentScope(req, project?.id ?? null, "create");
    const author = req.user?.role === "agent" ? req.user.username : updatedBy;
    const duplicate = project
      ? app.db.prepare("SELECT id FROM specs WHERE project_id = ? AND filename = ?").get(project.id, filename)
      : app.db.prepare("SELECT id FROM specs WHERE project_type_id = ? AND project_id IS NULL AND filename = ?").get(pt.id, filename);
    if (duplicate) throw new HttpError(409, `Spec ${filename} already exists for ${pt.name}`);

    const id = uuid();
    const ts = now();
    const auditPrompt = auditPromptForSpec({
      id,
      filename,
      content,
      current_version: "0.1.0",
    });
    app.db
      .prepare(
        `INSERT INTO specs (id, project_type_id, project_id, filename, current_version, status, content, updated_by, audit_prompt, created_at, updated_at)
         VALUES (?, ?, ?, ?, '0.1.0', 'draft', ?, ?, ?, ?, ?)`
      )
      .run(id, pt.id, project?.id ?? null, filename, content, author, auditPrompt, ts, ts);
    reply.code(201);
    return requireSpec(app.db, id);
  });

  // Direct edits are only allowed while a spec is still a draft.
  app.put("/specs/:key", async (req) => {
    const { key } = req.params as { key: string };
    const spec = requireSpec(app.db, key);
    if (spec.status !== "draft") {
      throw new HttpError(409, "Published specs change via the review workflow (POST /specs/review)");
    }
    assertAgentScope(req, spec.project_id, "edit");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const content = requireString(body, "content");
    const updatedBy = req.user?.role === "agent" ? req.user.username : requireString(body, "updated_by");
    app.db
      .prepare("UPDATE specs SET content = ?, updated_by = ?, updated_at = ? WHERE id = ?")
      .run(content, updatedBy, now(), spec.id);
    return requireSpec(app.db, spec.id);
  });

  // Publish a draft: becomes 1.0.0 and gains an immutable version record.
  app.post("/specs/:key/publish", async (req) => {
    const { key } = req.params as { key: string };
    const spec = requireSpec(app.db, key);
    if (spec.status !== "draft") throw new HttpError(409, `Spec is not a draft (status: ${spec.status})`);
    assertAgentScope(req, spec.project_id, "publish");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const publishedBy = req.user?.role === "agent" ? req.user.username : requireString(body, "published_by");
    const ts = now();
    const version = "1.0.0";
    const publish = app.db.transaction(() => {
      app.db
        .prepare("UPDATE specs SET status = 'published', current_version = ?, updated_by = ?, updated_at = ? WHERE id = ?")
        .run(version, publishedBy, ts, spec.id);
      app.db
        .prepare(
          `INSERT INTO spec_versions (id, spec_id, version, content, published_by, published_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(uuid(), spec.id, version, spec.content, publishedBy, ts);
    });
    publish();
    const published = requireSpec(app.db, spec.id);
    await reindexSpecSearch(app.db, published);
    const lint = lintContent(app.db, published.filename, published.content);
    await dispatchWebhooks(app.db, "spec.published", `${published.filename} published as 1.0.0 by ${publishedBy}`, {
      spec_id: published.id,
      filename: published.filename,
      version,
    });
    recordAudit(app.db, {
      actor: actorFrom(req, publishedBy),
      action: "spec.published",
      target_type: "spec",
      target_id: published.id,
      summary: `${published.filename} published as 1.0.0`,
      detail: { filename: published.filename, version },
    });
    return { ...published, lint };
  });

  // Compile the governed spec set into an agent context file (CLAUDE.md / AGENTS.md / .cursorrules).
  app.get("/specs/:key/compile", async (req) => {
    const { key } = req.params as { key: string };
    const { target, channel, project_id, repo } = req.query as { target?: string; channel?: string; project_id?: string; repo?: string };
    const pt = requireProjectType(app.db, key);
    const project = projectFromQuery(app, pt.id, { project_id, repo });
    const compileTarget = (target ?? "claude") as CompileTarget;
    if (!["claude", "agents", "cursor"].includes(compileTarget)) {
      throw new HttpError(400, "target must be one of: claude, agents, cursor");
    }
    recordUsage(app.db, "download", pt.id, `compile:${compileTarget}`);
    return compileBundle(app.db, pt, compileTarget, channel ?? "stable", project?.id);
  });

  // One-click agent onboarding pack: generated agent files, MCP config, and MCP skill guide.
  app.get("/specs/:key/agent-pack", async (req, reply) => {
    const { key } = req.params as { key: string };
    const { channel, project_id, repo } = req.query as { channel?: string; project_id?: string; repo?: string };
    const pt = requireProjectType(app.db, key);
    const project = projectFromQuery(app, pt.id, { project_id, repo });
    const zip = new AdmZip();
    for (const target of ["claude", "agents", "cursor"] as const) {
      const compiled = compileBundle(app.db, pt, target, channel ?? "stable", project?.id);
      zip.addFile(compiled.target_filename, Buffer.from(compiled.content, "utf8"));
    }
    const serverUrl = publicUrl(req);
    zip.addFile(".mcp.json", Buffer.from(JSON.stringify(mcpConfig(serverUrl, pt, project?.repo), null, 2) + "\n", "utf8"));
    zip.addFile("SPECREGISTRY_MCP_SKILL.md", Buffer.from(mcpSkillMarkdown(serverUrl, pt, project?.repo), "utf8"));
    const skills = app.db
      .prepare("SELECT * FROM agent_skills WHERE status = 'active' AND built_in = 1 AND risk_level = 'safe' ORDER BY name")
      .all() as AgentSkillRecord[];
    for (const skill of skills) {
      zip.addFile(`.spec/skills/${skill.slug}/SKILL.md`, Buffer.from(renderSkillMarkdown(skill), "utf8"));
    }
    zip.addFile(
      ".spec/skills/manifest.json",
      Buffer.from(JSON.stringify({ source: "specregistry", skills: skills.map(({ id, slug, name, description, risk_level }) => ({ id, slug, name, description, risk_level })) }, null, 2) + "\n", "utf8")
    );
    recordUsage(app.db, "download", pt.id, "agent-pack");
    reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${pt.name.replace(/[^\w.-]+/g, "_")}-agent-pack.zip"`);
    return zip.toBuffer();
  });

  // Promote a beta version to the stable head.
  app.post("/specs/:key/promote", async (req) => {
    const { key } = req.params as { key: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const promotedBy = requireString(body, "promoted_by");
    const version = requireString(body, "version");
    const spec = requireSpec(app.db, key);
    const beta = app.db
      .prepare("SELECT * FROM spec_versions WHERE spec_id = ? AND version = ? AND channel != 'stable'")
      .get(spec.id, version) as SpecVersion | undefined;
    if (!beta) throw new HttpError(404, `No beta version ${version} for ${spec.filename}`);

    const stableVersion = version.replace(/-.*$/, "");
    const conflict = app.db
      .prepare("SELECT id FROM spec_versions WHERE spec_id = ? AND version = ?")
      .get(spec.id, stableVersion);
    if (conflict) throw new HttpError(409, `Stable version ${stableVersion} already exists`);

    const ts = now();
    const promote = app.db.transaction(() => {
      app.db
        .prepare("UPDATE specs SET content = ?, current_version = ?, updated_by = ?, updated_at = ? WHERE id = ?")
        .run(beta.content, stableVersion, promotedBy, ts, spec.id);
      app.db
        .prepare(
          `INSERT INTO spec_versions (id, spec_id, version, content, published_by, published_at, channel)
           VALUES (?, ?, ?, ?, ?, ?, 'stable')`
        )
        .run(uuid(), spec.id, stableVersion, beta.content, promotedBy, ts);
    });
    promote();

    const updated = requireSpec(app.db, spec.id);
    await reindexSpecSearch(app.db, updated);
    enqueueSyncJobs(app.db, updated);
    await dispatchWebhooks(app.db, "spec.published", `${updated.filename} v${stableVersion} promoted from ${version}`, {
      spec_id: updated.id,
      filename: updated.filename,
      version: stableVersion,
    });
    recordAudit(app.db, {
      actor: actorFrom(req, promotedBy),
      action: "spec.promoted",
      target_type: "spec",
      target_id: updated.id,
      summary: `${updated.filename} promoted to ${stableVersion}`,
      detail: { from: version, version: stableVersion },
    });
    return updated;
  });

  // Submit a markdown change request; the spec enters pending_review.
  app.post("/specs/review", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const specId = requireString(body, "spec_id");
    const proposedContent = requireString(body, "proposed_content");
    const proposedBy = requireString(body, "proposed_by");
    const versionDelta = requireOneOf(body, "version_delta", ["major", "minor", "patch"] as const satisfies readonly VersionDelta[]);
    const spec = requireSpec(app.db, specId);
    const cr = createChangeRequest(app.db, {
      spec,
      proposedContent,
      versionDelta,
      proposedBy,
      summary: (body.summary as string) ?? null,
    });
    await dispatchWebhooks(
      app.db,
      "review.submitted",
      `${spec.filename}: ${versionDelta} change proposed by ${proposedBy}`,
      { change_request_id: cr.id, spec_id: spec.id, filename: spec.filename }
    );
    recordAudit(app.db, {
      actor: actorFrom(req, proposedBy),
      action: "review.submitted",
      target_type: "change_request",
      target_id: cr.id,
      summary: `${spec.filename}: ${versionDelta} change proposed by ${proposedBy}`,
      detail: { spec_id: spec.id, filename: spec.filename, version_delta: versionDelta },
    });
    reply.code(201);
    return cr;
  });

  // Admin-only: soft-delete a spec (retained for 14 days before purge).
  app.delete("/specs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (body.confirm !== true) {
      throw new HttpError(400, "Deletion requires { confirm: true } in the request body");
    }

    const spec = app.db.prepare("SELECT * FROM specs WHERE id = ? AND deleted_at IS NULL").get(id) as Spec | undefined;
    if (!spec) throw new HttpError(404, `Unknown spec: ${id}`);

    const ts = now();
    app.db.prepare("UPDATE specs SET deleted_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, id);

    // Remove from search index immediately
    app.db.prepare("DELETE FROM spec_chunks WHERE spec_id = ?").run(id);
    app.db.prepare("DELETE FROM spec_embeddings WHERE spec_id = ?").run(id);

    recordAudit(app.db, {
      actor: actorFrom(req, "admin"),
      action: "spec.deleted",
      target_type: "spec",
      target_id: id,
      summary: `Spec soft-deleted: ${spec.filename} (retained 14 days)`,
      detail: { filename: spec.filename, version: spec.current_version, status: spec.status },
    });

    reply.code(204);
  });

  // Admin-only: restore a soft-deleted spec.
  app.post("/specs/:id/restore", async (req) => {
    const { id } = req.params as { id: string };
    const spec = app.db.prepare("SELECT * FROM specs WHERE id = ?").get(id) as Spec | undefined;
    if (!spec) throw new HttpError(404, `Unknown spec: ${id}`);
    if (!spec.deleted_at) throw new HttpError(400, "Spec is not deleted");
    const conflict = spec.project_id
      ? app.db.prepare("SELECT id FROM specs WHERE project_id = ? AND filename = ? AND deleted_at IS NULL").get(spec.project_id, spec.filename)
      : app.db.prepare("SELECT id FROM specs WHERE project_type_id = ? AND project_id IS NULL AND filename = ? AND deleted_at IS NULL").get(spec.project_type_id, spec.filename);
    if (conflict) throw new HttpError(409, `Cannot restore ${spec.filename}; an active spec with that filename already exists`);

    const ts = now();
    app.db.prepare("UPDATE specs SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(ts, id);

    // Rebuild search index for this spec
    try { reindexSpecSearch(app.db, { id, content: spec.content }); } catch { /* non-fatal */ }

    recordAudit(app.db, {
      actor: actorFrom(req, "admin"),
      action: "spec.restored",
      target_type: "spec",
      target_id: id,
      summary: `Spec restored: ${spec.filename}`,
      detail: { filename: spec.filename, version: spec.current_version },
    });

    return app.db.prepare("SELECT * FROM specs WHERE id = ?").get(id) as Spec;
  });

  // Admin-only: list soft-deleted specs.
  app.get("/specs/deleted", async () => {
    return app.db.prepare(
      `SELECT s.id, s.project_type_id, s.filename, s.current_version, s.status,
              s.updated_by, s.deleted_at, s.created_at, s.updated_at,
              pt.name AS project_type_name
       FROM specs s
       JOIN project_types pt ON pt.id = s.project_type_id
       WHERE s.deleted_at IS NOT NULL
       ORDER BY s.deleted_at DESC`
    ).all();
  });

  // Admin-only: permanently purge soft-deleted specs older than 14 days.
  app.post("/specs/purge", async (req) => {
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const expired = app.db.prepare(
      "SELECT id, filename FROM specs WHERE deleted_at IS NOT NULL AND deleted_at < ?"
    ).all(cutoff) as Array<{ id: string; filename: string }>;

    const purge = app.db.transaction(() => {
      for (const s of expired) {
        app.db.prepare(
          "DELETE FROM review_approvals WHERE change_request_id IN (SELECT id FROM change_requests WHERE spec_id = ?)"
        ).run(s.id);
        app.db.prepare("DELETE FROM change_requests WHERE spec_id = ?").run(s.id);
        app.db.prepare("DELETE FROM spec_versions WHERE spec_id = ?").run(s.id);
        app.db.prepare("DELETE FROM agent_feedback WHERE spec_id = ?").run(s.id);
        app.db.prepare("DELETE FROM sync_jobs WHERE spec_id = ?").run(s.id);
        app.db.prepare("DELETE FROM efficacy_runs WHERE spec_id = ?").run(s.id);
        app.db.prepare("DELETE FROM spec_chunks WHERE spec_id = ?").run(s.id);
        app.db.prepare("DELETE FROM spec_embeddings WHERE spec_id = ?").run(s.id);
        app.db.prepare("DELETE FROM specs WHERE id = ?").run(s.id);
      }
    });

    purge();

    if (expired.length > 0) {
      recordAudit(app.db, {
        actor: actorFrom(req, "admin"),
        action: "spec.purged",
        target_type: "spec",
        target_id: "batch",
        summary: `Purged ${expired.length} soft-deleted spec(s) older than 14 days`,
        detail: { purged: expired.map(s => s.filename) },
      });
    }

    return { purged: expired.length, filenames: expired.map(s => s.filename) };
  });
}
