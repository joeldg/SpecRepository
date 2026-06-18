import type { FastifyInstance } from "fastify";
import type { AgentFeedback, FeedbackErrorType, Spec } from "@specregistry/shared";
import { now, uuid } from "../db.js";
import { findProjectConsumer, HttpError, requireOneOf, requireProjectType, requireSpec, requireString } from "../helpers.js";
import { draftFix } from "../lib/aifix.js";
import { mcpConfig, mcpSkillMarkdown } from "../lib/agentPack.js";
import { publicUrl } from "../lib/publicUrl.js";
import { auditCodebase, runEfficacy, type AuditInput } from "../lib/audit.js";
import { createChangeRequest } from "../lib/changes.js";
import { uuid as makeId } from "../db.js";
import { dispatchWebhooks, recordUsage } from "../lib/events.js";
import { searchSpecsByMode, type SearchMode } from "../lib/search.js";
import { splitSections } from "../lib/sections.js";
import { bundleSpecs } from "../lib/compile.js";

function feedbackClusterKey(row: Pick<AgentFeedback, "spec_id" | "error_type" | "description">): string {
  const normalized = row.description
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 10)
    .join(" ");
  return `${row.spec_id}:${row.error_type}:${normalized}`;
}

export async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  // Agent-facing onboarding guide: feed this markdown to an agent so it knows how
  // to configure and use the SpecRegistry MCP server in a codebase.
  app.get("/ai/mcp-guide/:projectType?", async (req) => {
    const { projectType } = req.params as { projectType?: string };
    const pt = projectType ? requireProjectType(app.db, projectType) : undefined;
    const serverUrl = publicUrl(req);
    return {
      filename: "SPECREGISTRY_MCP_SKILL.md",
      project_type: pt?.name ?? null,
      mcp_config: mcpConfig(serverUrl, pt),
      content: mcpSkillMarkdown(serverUrl, pt),
    };
  });

  // Agent-facing read endpoint: latest published specs (global + project type), full content.
  app.get("/ai/specs/:projectType", async (req) => {
    const { projectType } = req.params as { projectType: string };
    const { project_id, repo } = req.query as { project_id?: string; repo?: string };
    const pt = requireProjectType(app.db, projectType);
    const project = project_id ? findProjectConsumer(app.db, project_id, pt.id) : repo ? findProjectConsumer(app.db, repo, pt.id) : undefined;
    recordUsage(app.db, "agent_read", pt.id);
    const specs = bundleSpecs(app.db, pt.id, "stable", project?.id) as Array<Spec & { project_type_name?: string; project_type_scope: string }>;
    return {
      project_type: pt.name,
      project: project?.repo ?? null,
      specs: specs.map((spec) => ({
        ...spec,
        sections: splitSections(spec.content).map((section) => ({
          title: section.section,
          anchor: section.anchor,
          permalink: `/api/v1/specs/${spec.id}#${section.anchor}`,
        })),
      })),
    };
  });

  // Telemetry ingestion: agents flag ambiguities/contradictions for human review.
  app.post("/ai/feedback", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const specId = requireString(body, "spec_id");
    const agentIdentifier = requireString(body, "agent_identifier");
    const description = requireString(body, "description");
    const errorType = requireOneOf(body, "error_type", [
      "ambiguity",
      "contradiction",
      "outdated",
    ] as const satisfies readonly FeedbackErrorType[]);
    const spec: Spec = requireSpec(app.db, specId);
    const specVersion = typeof body.spec_version === "string" ? body.spec_version : spec.current_version;

    const id = uuid();
    app.db
      .prepare(
        `INSERT INTO agent_feedback (id, spec_id, spec_version, agent_identifier, error_type, context_code_snippet, description, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`
      )
      .run(
        id,
        spec.id,
        specVersion,
        agentIdentifier,
        errorType,
        (body.context_code_snippet as string) ?? null,
        description,
        now()
      );
    await dispatchWebhooks(
      app.db,
      "feedback.created",
      `${agentIdentifier} flagged ${spec.filename}@${specVersion}: ${errorType}`,
      { feedback_id: id, spec_id: spec.id, filename: spec.filename, error_type: errorType }
    );
    reply.code(201);
    return app.db.prepare("SELECT * FROM agent_feedback WHERE id = ?").get(id);
  });

  // RAG endpoint: section-level FTS, semantic, or hybrid search over published specs.
  app.get("/ai/search", async (req) => {
    const { q, project_type, project_id, repo, mode } = req.query as { q?: string; project_type?: string; project_id?: string; repo?: string; mode?: string };
    if (!q || !q.trim()) throw new HttpError(400, "Missing query parameter: q");
    const searchMode: SearchMode = mode === "semantic" || mode === "hybrid" || mode === "fts" ? mode : "fts";
    const pt = project_type ? requireProjectType(app.db, project_type) : undefined;
    const project = pt
      ? project_id
        ? findProjectConsumer(app.db, project_id, pt.id)
        : repo
          ? findProjectConsumer(app.db, repo, pt.id)
          : undefined
      : undefined;
    recordUsage(app.db, "search", pt?.id, q);
    return { query: q, mode: searchMode, project: project?.repo ?? null, results: await searchSpecsByMode(app.db, q, searchMode, pt?.id, 20, project?.id) };
  });

  // Close the loop: have the configured server LLM draft a revision that resolves the feedback,
  // then submit it through the normal review workflow as a pending change request.
  app.post("/ai/feedback/:id/draft-fix", async (req, reply) => {
    const { id } = req.params as { id: string };
    const feedback = app.db.prepare("SELECT * FROM agent_feedback WHERE id = ?").get(id) as
      | AgentFeedback
      | undefined;
    if (!feedback) throw new HttpError(404, `Unknown feedback: ${id}`);
    if (feedback.status === "resolved") throw new HttpError(409, "Feedback is already resolved");
    const spec = requireSpec(app.db, feedback.spec_id);
    if (spec.status === "pending_review") {
      throw new HttpError(409, "Spec already has a pending change request; review it first");
    }

    const revised = await draftFix(app.db, spec, feedback);
    const cr = createChangeRequest(app.db, {
      spec,
      proposedContent: revised,
      // Resolving a contradiction changes guidance; clarifications are patches.
      versionDelta: feedback.error_type === "ambiguity" ? "patch" : "minor",
      proposedBy: `claude-draft (for ${feedback.agent_identifier})`,
      summary: `AI-drafted fix for ${feedback.error_type} feedback: ${feedback.description.slice(0, 120)}`,
    });
    app.db.prepare("UPDATE agent_feedback SET status = 'acknowledged' WHERE id = ? AND status = 'open'").run(id);
    await dispatchWebhooks(app.db, "review.submitted", `${spec.filename}: AI-drafted fix awaiting review`, {
      change_request_id: cr.id,
      spec_id: spec.id,
      filename: spec.filename,
      feedback_id: id,
    });
    reply.code(201);
    return cr;
  });

  app.get("/ai/feedback", async (req) => {
    const { status } = req.query as { status?: string };
    const base = `
      SELECT f.*, s.filename, s.current_version, pt.name AS project_type_name
      FROM agent_feedback f
      JOIN specs s ON s.id = f.spec_id
      JOIN project_types pt ON pt.id = s.project_type_id
    `;
    if (status) {
      return app.db.prepare(`${base} WHERE f.status = ? ORDER BY f.created_at DESC`).all(status);
    }
    return app.db.prepare(`${base} ORDER BY f.created_at DESC`).all();
  });

  app.get("/ai/feedback/clusters", async (req) => {
    const { status } = req.query as { status?: string };
    const rows = app.db
      .prepare(
        `SELECT f.*, s.filename, pt.name AS project_type_name
         FROM agent_feedback f
         JOIN specs s ON s.id = f.spec_id
         JOIN project_types pt ON pt.id = s.project_type_id
         ${status ? "WHERE f.status = ?" : ""}
         ORDER BY f.created_at DESC`
      )
      .all(...(status ? [status] : [])) as Array<AgentFeedback & { filename: string; project_type_name: string }>;
    const clusters = new Map<string, Array<(typeof rows)[number]>>();
    for (const row of rows) {
      const key = feedbackClusterKey(row);
      clusters.set(key, [...(clusters.get(key) ?? []), row]);
    }
    return [...clusters.entries()]
      .map(([key, items]) => ({
        key,
        spec_id: items[0].spec_id,
        filename: items[0].filename,
        project_type_name: items[0].project_type_name,
        error_type: items[0].error_type,
        count: items.length,
        status_counts: items.reduce<Record<string, number>>((acc, item) => {
          acc[item.status] = (acc[item.status] ?? 0) + 1;
          return acc;
        }, {}),
        latest_at: items[0].created_at,
        sample_description: items[0].description,
        feedback_ids: items.map((item) => item.id),
      }))
      .sort((a, b) => b.count - a.count || b.latest_at.localeCompare(a.latest_at));
  });

  app.post("/ai/feedback/clusters/status", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = requireString(body, "key");
    const status = requireOneOf(body, "status", ["open", "acknowledged", "resolved"] as const);
    const rows = app.db.prepare("SELECT * FROM agent_feedback ORDER BY created_at DESC").all() as AgentFeedback[];
    const ids = rows.filter((row) => feedbackClusterKey(row) === key).map((row) => row.id);
    if (ids.length === 0) throw new HttpError(404, `Unknown feedback cluster: ${key}`);
    const update = app.db.prepare("UPDATE agent_feedback SET status = ? WHERE id = ?");
    const tx = app.db.transaction(() => {
      for (const id of ids) update.run(status, id);
    });
    tx();
    return { key, status, updated: ids.length, feedback_ids: ids };
  });

  app.post("/ai/feedback/clusters/draft-fix", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = requireString(body, "key");
    const rows = app.db.prepare("SELECT * FROM agent_feedback ORDER BY created_at DESC").all() as AgentFeedback[];
    const items = rows.filter((row) => feedbackClusterKey(row) === key && row.status !== "resolved");
    if (items.length === 0) throw new HttpError(404, `Unknown open feedback cluster: ${key}`);
    const first = items[0];
    const spec = requireSpec(app.db, first.spec_id);
    if (spec.status === "pending_review") throw new HttpError(409, "Spec already has a pending change request; review it first");
    const merged = {
      ...first,
      description: items.map((item, index) => `${index + 1}. ${item.description}`).join("\n"),
    };
    const revised = await draftFix(app.db, spec, merged);
    const cr = createChangeRequest(app.db, {
      spec,
      proposedContent: revised,
      versionDelta: first.error_type === "ambiguity" ? "patch" : "minor",
      proposedBy: `cluster-draft (for ${items.length} feedback items)`,
      summary: `AI-drafted fix for feedback cluster: ${first.description.slice(0, 100)}`,
    });
    const update = app.db.prepare("UPDATE agent_feedback SET status = 'acknowledged' WHERE id = ?");
    const tx = app.db.transaction(() => {
      for (const item of items) update.run(item.id);
    });
    tx();
    reply.code(201);
    return { ...cr, feedback_ids: items.map((item) => item.id) };
  });

  // Reverse conformance: does a codebase snapshot follow its governed specs?
  app.post("/ai/audit", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pt = requireProjectType(app.db, requireString(body, "project_type"));
    const tree = requireString(body, "tree");
    const files = Array.isArray(body.files)
      ? (body.files as AuditInput["files"]).filter(
          (f) => typeof f?.path === "string" && typeof f?.content === "string"
        )
      : [];
    const findings = await auditCodebase(app.db, pt, { tree, files });
    return { project_type: pt.name, findings, finding_count: findings.length };
  });

  // Spec efficacy A/B: does this spec measurably change agent output for a task?
  app.post("/ai/efficacy", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const spec = requireSpec(app.db, requireString(body, "spec_id"));
    const task = requireString(body, "task_prompt");
    const result = await runEfficacy(app.db, spec.content, spec.filename, task);
    const id = makeId();
    app.db
      .prepare(
        `INSERT INTO efficacy_runs (id, spec_id, task_prompt, score_with, score_without, improved, rationale, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        spec.id,
        task,
        result.score_with,
        result.score_without,
        result.improved ? 1 : 0,
        result.rationale,
        result.model,
        now()
      );
    reply.code(201);
    return app.db.prepare("SELECT * FROM efficacy_runs WHERE id = ?").get(id);
  });

  app.get("/ai/efficacy/trends", async (req) => {
    const { spec_id } = req.query as { spec_id?: string };
    const rows = app.db
      .prepare(
        `SELECT er.*, s.filename
         FROM efficacy_runs er JOIN specs s ON s.id = er.spec_id
         ${spec_id ? "WHERE er.spec_id = ?" : ""}
         ORDER BY er.created_at ASC`
      )
      .all(...(spec_id ? [spec_id] : []));
    return { spec_id: spec_id ?? null, runs: rows };
  });

  app.post("/ai/efficacy/scheduled-run", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const limit = Math.min(10, Math.max(1, Number(body.limit ?? 3) || 3));
    const task = typeof body.task_prompt === "string" && body.task_prompt.trim()
      ? body.task_prompt
      : "Assess whether this specification provides enough actionable guidance for an implementation agent.";
    const specs = app.db
      .prepare(
        `SELECT s.*
         FROM specs s
         LEFT JOIN agent_feedback af ON af.spec_id = s.id AND af.status = 'open'
         WHERE s.status = 'published'
         GROUP BY s.id
         ORDER BY COUNT(af.id) DESC, s.updated_at ASC
         LIMIT ?`
      )
      .all(limit) as Spec[];
    const results = [];
    for (const spec of specs) {
      const result = await runEfficacy(app.db, spec.content, spec.filename, task);
      const id = makeId();
      app.db
        .prepare(
          `INSERT INTO efficacy_runs (id, spec_id, task_prompt, score_with, score_without, improved, rationale, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, spec.id, task, result.score_with, result.score_without, result.improved ? 1 : 0, result.rationale, result.model, now());
      results.push(app.db.prepare("SELECT * FROM efficacy_runs WHERE id = ?").get(id));
    }
    return { requested: limit, ran: results.length, results };
  });

  app.post("/ai/regression-suite", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const spec = requireSpec(app.db, requireString(body, "spec_id"));
    const prompts = Array.isArray(body.prompts)
      ? (body.prompts as unknown[]).filter((prompt): prompt is string => typeof prompt === "string" && prompt.trim().length > 0).slice(0, 10)
      : [requireString(body, "task_prompt")];
    const results = [];
    for (const prompt of prompts) {
      const result = await runEfficacy(app.db, spec.content, spec.filename, prompt);
      results.push({ prompt, ...result });
    }
    return { spec_id: spec.id, filename: spec.filename, model_count: 1, results };
  });

  app.get("/ai/token-roi", async () => {
    const rows = app.db
      .prepare(
        `SELECT s.id, s.filename, s.current_version, LENGTH(s.content) AS chars, s.updated_at,
                pt.name AS project_type_name,
                COUNT(DISTINCT ue.id) AS usage_events,
                COUNT(DISTINCT af.id) AS feedback_total,
                COUNT(DISTINCT CASE WHEN af.status = 'open' THEN af.id END) AS open_feedback,
                COUNT(DISTINCT er.id) AS efficacy_runs,
                COUNT(DISTINCT CASE WHEN er.improved = 1 THEN er.id END) AS efficacy_improved,
                AVG(er.score_with - er.score_without) AS avg_lift
         FROM specs s
         JOIN project_types pt ON pt.id = s.project_type_id
         LEFT JOIN usage_events ue ON ue.project_type_id = s.project_type_id
         LEFT JOIN agent_feedback af ON af.spec_id = s.id
         LEFT JOIN efficacy_runs er ON er.spec_id = s.id
         WHERE s.status = 'published'
         GROUP BY s.id
         ORDER BY usage_events DESC, open_feedback DESC, chars DESC`
      )
      .all() as Array<Record<string, unknown> & { chars: number; usage_events: number; open_feedback: number; efficacy_runs: number; efficacy_improved: number; avg_lift: number | null }>;
    return {
      specs: rows.map((row) => {
        const approxTokens = Math.ceil(row.chars / 4);
        const lift = Number(row.avg_lift ?? 0);
        const roiScore = Math.round((Number(row.usage_events) * Math.max(1, lift + 1) + Number(row.efficacy_improved) * 5 - Number(row.open_feedback) * 3) / Math.max(1, approxTokens / 1000));
        return { ...row, approx_tokens: approxTokens, avg_lift: lift, roi_score: roiScore };
      }),
    };
  });

  // Spec authors triage alerts: open -> acknowledged -> resolved.
  app.post("/ai/feedback/:id/status", async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = requireOneOf(body, "status", ["open", "acknowledged", "resolved"] as const);
    const existing = app.db.prepare("SELECT id FROM agent_feedback WHERE id = ?").get(id);
    if (!existing) throw new HttpError(404, `Unknown feedback: ${id}`);
    app.db.prepare("UPDATE agent_feedback SET status = ? WHERE id = ?").run(status, id);
    return app.db.prepare("SELECT * FROM agent_feedback WHERE id = ?").get(id);
  });
}
