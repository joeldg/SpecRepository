import type { FastifyInstance } from "fastify";
import { styleGuidesForLanguages, type AgentFeedback, type FeedbackErrorType, type Spec } from "@specregistry/shared";
import { now, uuid } from "../db.js";
import { findProjectConsumer, HttpError, requireOneOf, requireProjectType, requireSpec, requireString } from "../helpers.js";
import { draftFix } from "../lib/aifix.js";
import { mcpConfig, mcpSkillMarkdown } from "../lib/agentPack.js";
import { publicUrl } from "../lib/publicUrl.js";
import { auditCodebase, runEfficacy, type AuditInput } from "../lib/audit.js";
import { createChangeRequest } from "../lib/changes.js";
import { uuid as makeId } from "../db.js";
import { dispatchWebhooks, recordUsage } from "../lib/events.js";
import { searchSpecsByMode, type SearchMode, type SearchResult } from "../lib/search.js";
import { evaluateCompliance } from "../lib/compliance.js";
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

const GUIDANCE_TOPIC_ALIASES: Array<{ triggers: string[]; query: string }> = [
  {
    triggers: ["agent", "operating", "requirement", "requirements", "mcp", "governance", "review"],
    query: "agents mcp get_specs report_spec_feedback",
  },
  {
    triggers: ["governance", "review", "approval", "publish", "change", "policy"],
    query: "spec governance review approval publish workflow",
  },
  {
    triggers: ["sdd", "process", "workflow", "operating", "model"],
    query: "sdd operating model governed repository feedback review",
  },
  {
    triggers: ["traceability", "observability", "compliance", "coverage", "drift"],
    query: "traceability observability compliance coverage drift",
  },
];

function normalizedWords(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(Boolean)
  );
}

function guidanceAliasQueries(topic: string): string[] {
  const words = normalizedWords(topic);
  return GUIDANCE_TOPIC_ALIASES.filter((alias) => {
    const matches = alias.triggers.filter((trigger) => words.has(trigger)).length;
    return matches >= 2 || (words.has("agent") && (words.has("governance") || words.has("review") || words.has("mcp")));
  }).map((alias) => alias.query);
}

function dedupeSearchResults(rows: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.spec_id}:${row.section_anchor}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [];
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

  // Agent lifecycle preflight. Agents call this when starting non-trivial work so
  // the registry records the task, active repo, model, loaded spec bundle, and
  // concrete next controls before edits begin.
  app.post("/ai/agent-sessions/begin", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pt = requireProjectType(app.db, requireString(body, "project_type"));
    const project =
      typeof body.project_id === "string"
        ? findProjectConsumer(app.db, body.project_id, pt.id)
        : typeof body.repo === "string"
          ? findProjectConsumer(app.db, body.repo, pt.id)
          : undefined;
    const specs = bundleSpecs(app.db, pt.id, "stable", project?.id) as Array<Spec & { project_type_name?: string; project_type_scope: string }>;
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (specs.length === 0) blockers.push("No published governed specs were found for this project type.");
    if (!project && !optionalString(body, "repo")) warnings.push("No registered repo/project identity was supplied; project-scoped specs and trace history may be unavailable.");
    if (stringList(body.specs_loaded).length === 0) warnings.push("Agent did not declare which spec files it loaded before starting.");

    const specBundle = specs.map((spec) => ({
      id: spec.id,
      filename: spec.filename,
      version: spec.current_version,
      scope: spec.project_id ? "project" : spec.project_type_scope,
      project_type: spec.project_type_name ?? pt.name,
    }));
    const session = {
      id: uuid(),
      agent_identifier: optionalString(body, "agent_identifier") ?? "mcp-agent",
      task: requireString(body, "task"),
      status: blockers.length === 0 ? "active" : "blocked",
      project_type_id: pt.id,
      consumer_id: project?.id ?? null,
      repo: project?.repo ?? optionalString(body, "repo") ?? null,
      branch: optionalString(body, "branch") ?? project?.branch ?? null,
      model: optionalString(body, "model") ?? null,
      mcp_server: optionalString(body, "mcp_server") ?? null,
      plan: optionalString(body, "plan") ?? null,
      preflight_summary: JSON.stringify({
        blockers,
        warnings,
        declared_specs_loaded: stringList(body.specs_loaded),
        next_required_tools: ["get_specs", "resolve_guidance as needed", "check_compliance or finish_task before completion"],
      }),
    };
    const ts = now();
    app.db
      .prepare(
          `INSERT INTO agent_sessions
          (id, agent_identifier, project_type_id, consumer_id, repo, branch, task, model, mcp_server,
           spec_count, spec_bundle, status, plan, preflight_summary, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.agent_identifier,
        session.project_type_id,
        session.consumer_id,
        session.repo,
        session.branch,
        session.task,
        session.model,
        session.mcp_server,
        specBundle.length,
        JSON.stringify(specBundle),
        session.status,
        session.plan,
        session.preflight_summary,
        ts,
        ts
      );
    recordUsage(app.db, "agent_read", pt.id, "agent-session-begin");
    reply.code(201);
    return {
      session_id: session.id,
      status: blockers.length === 0 ? "ready" : "blocked",
      project_type: pt.name,
      project: project?.repo ?? session.repo,
      blockers,
      warnings,
      specs: specBundle,
      required_finish_tool: "finish_task",
      directive:
        blockers.length === 0
          ? "PREFLIGHT READY — load the listed specs, follow the declared plan, and call finish_task before claiming completion."
          : "PREFLIGHT BLOCKED — resolve blockers or report spec feedback before editing.",
    };
  });

  // Agent lifecycle completion gate. This wraps the compliance evaluator, updates
  // the session, and refuses a completion status until objective compliance passes.
  app.post("/ai/agent-sessions/finish", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = optionalString(body, "session_id");
    const session = sessionId
      ? (app.db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(sessionId) as
          | {
              id: string;
              project_type_id: string | null;
              consumer_id: string | null;
              repo: string | null;
              task: string;
            }
          | undefined)
      : undefined;
    if (sessionId && !session) throw new HttpError(404, `Unknown agent session: ${sessionId}`);
    const pt = session?.project_type_id
      ? requireProjectType(app.db, session.project_type_id)
      : requireProjectType(app.db, requireString(body, "project_type"));
    const project =
      session?.consumer_id
        ? findProjectConsumer(app.db, session.consumer_id, pt.id)
        : typeof body.project_id === "string"
          ? findProjectConsumer(app.db, body.project_id, pt.id)
          : typeof body.repo === "string"
            ? findProjectConsumer(app.db, body.repo, pt.id)
            : undefined;
    const trace = body.trace && typeof body.trace === "object" ? (body.trace as Record<string, unknown>) : undefined;
    const selfAssessedScore = typeof body.self_assessed_score === "number" ? body.self_assessed_score : null;
    const verdict = evaluateCompliance(app.db, {
      pt,
      consumerId: project?.id ?? session?.consumer_id ?? undefined,
      repo: project?.repo ?? session?.repo ?? optionalString(body, "repo"),
      trace,
      selfAssessedScore,
    });
    const latestAttestation = (project?.repo ?? session?.repo ?? optionalString(body, "repo"))
      ? (app.db
          .prepare("SELECT id FROM compliance_attestations WHERE repo = ? ORDER BY created_at DESC LIMIT 1")
          .get(project?.repo ?? session?.repo ?? optionalString(body, "repo")) as { id: string } | undefined)
      : undefined;
    const status = verdict.compliant ? "completed" : "blocked";
    const completionSummary = {
      summary: optionalString(body, "summary") ?? null,
      tests: stringList(body.tests),
      changed_files: stringList(body.changed_files),
      outstanding: verdict.outstanding,
      objective_score: verdict.objective_score,
    };
    if (session) {
      const ts = now();
      app.db
        .prepare(
          `UPDATE agent_sessions
           SET status = ?, completion_summary = ?, compliance_attestation_id = ?, completed_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(status, JSON.stringify(completionSummary), latestAttestation?.id ?? null, verdict.compliant ? ts : null, ts, session.id);
    }
    recordUsage(app.db, "sync_check", pt.id, "agent-session-finish");
    return {
      session_id: session?.id ?? null,
      status,
      compliant: verdict.compliant,
      compliance: verdict,
      directive: verdict.compliant
        ? "COMPLETION ACCEPTED — objective compliance passed and the session may be reported complete."
        : "COMPLETION BLOCKED — objective compliance failed. Continue remediation and call finish_task again.",
    };
  });

  app.get("/ai/agent-sessions", async (req) => {
    const { repo, status, limit } = req.query as { repo?: string; status?: string; limit?: string };
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (repo) {
      clauses.push("repo = ?");
      params.push(repo);
    }
    if (status && ["active", "completed", "blocked"].includes(status)) {
      clauses.push("status = ?");
      params.push(status);
    }
    params.push(Math.max(1, Math.min(200, Number(limit ?? 50) || 50)));
    const rows = app.db
      .prepare(
        `SELECT s.*, pt.name AS project_type_name
         FROM agent_sessions s
         LEFT JOIN project_types pt ON pt.id = s.project_type_id
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY s.started_at DESC
         LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...row,
      spec_bundle: typeof row.spec_bundle === "string" ? JSON.parse(row.spec_bundle) : [],
      preflight_summary: typeof row.preflight_summary === "string" && row.preflight_summary ? JSON.parse(row.preflight_summary) : null,
      completion_summary: typeof row.completion_summary === "string" && row.completion_summary ? JSON.parse(row.completion_summary) : null,
    }));
  });

  // Compliance verification loop. Agents call this before declaring a task done.
  // The gate is objective (measured coverage/drift/unmapped vs the project-type
  // policy); the agent's self-assessed score is recorded and over-claims flagged.
  // Returns a directive that loops the agent until it actually passes.
  app.post("/ai/compliance-check", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pt = requireProjectType(app.db, requireString(body, "project_type"));
    const project =
      typeof body.project_id === "string"
        ? findProjectConsumer(app.db, body.project_id, pt.id)
        : typeof body.repo === "string"
          ? findProjectConsumer(app.db, body.repo, pt.id)
          : undefined;
    const trace = body.trace && typeof body.trace === "object" ? (body.trace as Record<string, unknown>) : undefined;
    const selfAssessedScore = typeof body.self_assessed_score === "number" ? body.self_assessed_score : null;
    recordUsage(app.db, "sync_check", pt.id, "compliance-check");
    return evaluateCompliance(app.db, {
      pt,
      consumerId: project?.id,
      repo: project?.repo ?? (typeof body.repo === "string" ? body.repo : undefined),
      trace,
      selfAssessedScore,
    });
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

  // On-demand guidance resolution. Given the language(s) an agent is about to write in
  // and/or the domain/topic it is about to work on, return the governed specs that apply,
  // the styleguides available to pull, and explicit gaps — so the agent fetches the right
  // guidance (or reports the gap) instead of inventing a standard.
  app.post("/ai/resolve-guidance", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pt = body.project_type ? requireProjectType(app.db, requireString(body, "project_type")) : undefined;
    const project = pt
      ? typeof body.project_id === "string"
        ? findProjectConsumer(app.db, body.project_id, pt.id)
        : typeof body.repo === "string"
          ? findProjectConsumer(app.db, body.repo, pt.id)
          : undefined
      : undefined;
    const languages = Array.isArray(body.languages)
      ? (body.languages as unknown[]).filter((l): l is string => typeof l === "string" && l.trim() !== "")
      : [];
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    if (languages.length === 0 && !topic) {
      throw new HttpError(400, "Provide at least one of: languages[], topic");
    }
    recordUsage(app.db, "search", pt?.id, `resolve-guidance:${[...languages, topic].filter(Boolean).join("|")}`);

    // Governed specs relevant to the topic and/or languages (FTS: no embedding dependency).
    const query = [topic, ...languages].filter(Boolean).join(" ");
    const specs = query ? await searchSpecsByMode(app.db, query, "fts", pt?.id, 8, project?.id) : [];
    const aliasSpecs = topic
      ? (
          await Promise.all(
            guidanceAliasQueries(topic).map((aliasQuery) =>
              searchSpecsByMode(app.db, aliasQuery, "fts", pt?.id, 4, project?.id)
            )
          )
        ).flat()
      : [];
    const resolvedSpecs = dedupeSearchResults([...specs, ...aliasSpecs]).slice(0, 8);

    // Styleguides available to pull, one entry per requested language.
    const perLanguage = languages.map((language) => {
      const match = styleGuidesForLanguages([language])[0];
      return {
        language,
        styleguide: match
          ? {
              id: match.id,
              title: match.title,
              sources: match.sources.map((s) => s.url),
              pull_command: `specreg styleguide add ${match.id}`,
            }
          : null,
      };
    });
    const styleguides = [
      ...new Map(perLanguage.filter((l) => l.styleguide).map((l) => [l.styleguide!.id, l.styleguide!])).values(),
    ];

    const gaps: Array<{ kind: "styleguide" | "spec"; subject: string; detail: string; recommended_action: string }> = [];
    for (const l of perLanguage) {
      if (!l.styleguide) {
        gaps.push({
          kind: "styleguide",
          subject: l.language,
          detail: `No styleguide is available for ${l.language} in the registry catalog.`,
          recommended_action: `Report the gap with report_spec_feedback (or ask an admin to add a styleguide/spec for ${l.language}). Do not invent the standard.`,
        });
      }
    }
    if (topic && resolvedSpecs.length === 0) {
      gaps.push({
        kind: "spec",
        subject: topic,
        detail: `No governed spec covers "${topic}" for this project.`,
        recommended_action: `Report the gap with report_spec_feedback, then draft one with \`specreg generate\` and submit it through review.`,
      });
    }

    const recommended_actions: string[] = [];
    for (const sg of styleguides) recommended_actions.push(`Pull the ${sg.title}: \`${sg.pull_command}\``);
    if (resolvedSpecs.length > 0) recommended_actions.push("Load the matched governed specs before writing code.");
    if (gaps.length > 0) recommended_actions.push("Report uncovered languages/domains via report_spec_feedback instead of guessing.");

    return {
      project_type: pt?.name ?? null,
      project: project?.repo ?? null,
      languages: perLanguage,
      styleguides,
      specs: resolvedSpecs,
      covered: gaps.length === 0,
      gaps,
      recommended_actions,
    };
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
      WHERE s.deleted_at IS NULL
    `;
    if (status) {
      return app.db.prepare(`${base} AND f.status = ? ORDER BY f.created_at DESC`).all(status);
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
         WHERE s.deleted_at IS NULL
         ${status ? "AND f.status = ?" : ""}
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
         WHERE s.deleted_at IS NULL
         ${spec_id ? "AND er.spec_id = ?" : ""}
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
         WHERE s.status = 'published' AND s.deleted_at IS NULL
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
         WHERE s.status = 'published' AND s.deleted_at IS NULL
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
