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
import {
  listLlmModels,
  LLM_ROUTE_VALUES,
  LLM_TIER_VALUES,
  publicLlmConfig,
  publicLlmTierConfig,
  publicLlmTieringConfig,
  runLlmText,
  saveLlmConfig,
  saveLlmRoutes,
  saveLlmTierConfig,
  type LlmConfig,
  type LlmTaskRoute,
  type LlmTier,
} from "../lib/llm.js";
import { getAppKeyConfig, publicAppKeyConfig, saveAppKeyConfig, type AppKeyConfig } from "../lib/appKeys.js";
import { pullAndRebuild } from "../lib/versionInfo.js";
import {
  publicEmbeddingConfig,
  reindexSemanticAll,
  saveEmbeddingConfig,
  semanticIndexStatus,
  type EmbeddingConfig,
} from "../lib/embeddings.js";
import { getFeatureConfig, getHarnessImprovementFeatureFlags, saveFeatureConfig, type FeatureConfig } from "../lib/features.js";
import { DEFAULT_COMPLIANCE_POLICY, getCompliancePolicy } from "../lib/compliance.js";
import { renderSkillMarkdown, type AgentSkillRecord } from "../lib/skills.js";

function isLlmTier(value: unknown): value is LlmTier {
  return typeof value === "string" && LLM_TIER_VALUES.includes(value as LlmTier);
}

function isLlmRoute(value: unknown): value is LlmTaskRoute {
  return typeof value === "string" && LLM_ROUTE_VALUES.includes(value as LlmTaskRoute);
}

function harnessImprovementInsights(app: FastifyInstance) {
  const flags = getHarnessImprovementFeatureFlags(app.db);
  if (!flags.enabled || !flags.failure_pattern_mining) {
    return {
      enabled: flags.enabled,
      generated_at: now(),
      summary: { patterns: 0, evidence_items: 0 },
      patterns: [],
    };
  }

  const patterns: Array<{
    key: string;
    title: string;
    category: string;
    severity: "low" | "medium" | "high";
    support: number;
    evidence: string[];
    proposed_surface: string;
    suggested_action: string;
    validation_gate: string;
  }> = [];

  const blockedFinishes = app.db
    .prepare(
      `SELECT COALESCE(repo, 'unreported repo') AS repo, COUNT(*) AS n
       FROM agent_sessions
       WHERE status = 'blocked' AND completion_summary IS NOT NULL
       GROUP BY COALESCE(repo, 'unreported repo')
       ORDER BY n DESC
       LIMIT 5`
    )
    .all() as Array<{ repo: string; n: number }>;
  const blockedTotal = blockedFinishes.reduce((sum, row) => sum + Number(row.n), 0);
  if (blockedTotal > 0) {
    patterns.push({
      key: "blocked-finish-compliance",
      title: "Agents are reaching completion with failing objective compliance",
      category: "completion_gate",
      severity: blockedTotal >= 5 ? "high" : "medium",
      support: blockedTotal,
      evidence: blockedFinishes.map((row) => `${row.repo}: ${row.n} blocked finish attempt${row.n === 1 ? "" : "s"}`),
      proposed_surface: "run-compliance-loop skill, finish_task directive, generated agent guidance",
      suggested_action: "Tighten completion guidance around code-map refresh, outstanding remediation, and re-running finish_task before claiming done.",
      validation_gate: "New sessions should show fewer blocked finish attempts without reducing completed compliant sessions.",
    });
  }

  const missingGuidance = app.db
    .prepare(
      `SELECT COALESCE(pt.name, 'Unknown project type') AS project_type_name,
              COALESCE(f.topic, f.languages, 'unclassified') AS subject,
              COUNT(*) AS n
       FROM agent_feedback f
       LEFT JOIN project_types pt ON pt.id = f.project_type_id
       WHERE f.error_type = 'missing_guidance' AND f.status = 'open'
       GROUP BY project_type_name, subject
       ORDER BY n DESC
       LIMIT 5`
    )
    .all() as Array<{ project_type_name: string; subject: string; n: number }>;
  const missingTotal = missingGuidance.reduce((sum, row) => sum + Number(row.n), 0);
  if (missingTotal > 0) {
    patterns.push({
      key: "repeated-missing-guidance",
      title: "Agents repeatedly report missing language or domain guidance",
      category: "coverage_gap",
      severity: missingTotal >= 5 ? "high" : "medium",
      support: missingTotal,
      evidence: missingGuidance.map((row) => `${row.project_type_name} / ${row.subject}: ${row.n} open gap${row.n === 1 ? "" : "s"}`),
      proposed_surface: "resolve-uncovered-guidance skill, project-type specs, styleguide selection",
      suggested_action: "Draft a governed spec or styleguide acquisition path for the highest-support uncovered topics.",
      validation_gate: "Future resolve_guidance calls for the same topic should return governed coverage rather than a gap.",
    });
  }

  const overclaims = app.db
    .prepare(
      `SELECT COALESCE(repo, 'unreported repo') AS repo,
              COUNT(*) AS n,
              ROUND(AVG(self_assessed_score - objective_score), 1) AS avg_gap
       FROM compliance_attestations
       WHERE self_assessed_score IS NOT NULL AND self_assessed_score - objective_score >= 20
       GROUP BY COALESCE(repo, 'unreported repo')
       ORDER BY n DESC, avg_gap DESC
       LIMIT 5`
    )
    .all() as Array<{ repo: string; n: number; avg_gap: number }>;
  const overclaimTotal = overclaims.reduce((sum, row) => sum + Number(row.n), 0);
  if (overclaimTotal > 0) {
    patterns.push({
      key: "self-assessment-overclaim",
      title: "Agents overestimate completion compared with objective compliance",
      category: "calibration",
      severity: overclaimTotal >= 5 ? "high" : "medium",
      support: overclaimTotal,
      evidence: overclaims.map((row) => `${row.repo}: ${row.n} overclaim${row.n === 1 ? "" : "s"}, avg gap ${row.avg_gap} points`),
      proposed_surface: "collect-delivery-evidence skill, check_compliance directive, MCP tool descriptions",
      suggested_action: "Add calibration language that separates self-assessment from objective score and requires concrete evidence for high confidence.",
      validation_gate: "The self-assessed/objective score gap should narrow without suppressing honest failed compliance reports.",
    });
  }

  const feedbackClusters = app.db
    .prepare(
      `SELECT f.error_type, COALESCE(s.filename, 'spec-less gap') AS filename, COUNT(*) AS n
       FROM agent_feedback f
       LEFT JOIN specs s ON s.id = f.spec_id
       WHERE f.status = 'open' AND f.error_type IN ('ambiguity', 'contradiction', 'outdated')
       GROUP BY f.error_type, filename
       HAVING COUNT(*) > 1
       ORDER BY n DESC
       LIMIT 5`
    )
    .all() as Array<{ error_type: string; filename: string; n: number }>;
  const feedbackTotal = feedbackClusters.reduce((sum, row) => sum + Number(row.n), 0);
  if (feedbackTotal > 0) {
    patterns.push({
      key: "repeated-spec-feedback",
      title: "Open feedback clusters suggest harness or spec guidance is not resolving confusion",
      category: "spec_interpretation",
      severity: feedbackTotal >= 5 ? "high" : "medium",
      support: feedbackTotal,
      evidence: feedbackClusters.map((row) => `${row.filename}: ${row.n} ${row.error_type} report${row.n === 1 ? "" : "s"}`),
      proposed_surface: "report-spec-problems skill, affected specs, review triage workflow",
      suggested_action: "Use the cluster as evidence for a narrow spec revision or clearer stop-and-report behavior.",
      validation_gate: "The same cluster should stop recurring after the reviewed spec or skill update is published.",
    });
  }

  const staleActive = app.db
    .prepare(
      `SELECT COALESCE(repo, 'unreported repo') AS repo, COUNT(*) AS n
       FROM agent_sessions
       WHERE status = 'active' AND julianday(started_at) < julianday('now', '-24 hours')
       GROUP BY COALESCE(repo, 'unreported repo')
       ORDER BY n DESC
       LIMIT 5`
    )
    .all() as Array<{ repo: string; n: number }>;
  const staleTotal = staleActive.reduce((sum, row) => sum + Number(row.n), 0);
  if (staleTotal > 0) {
    patterns.push({
      key: "stale-agent-sessions",
      title: "Agent sessions remain active long after task start",
      category: "lifecycle",
      severity: staleTotal >= 5 ? "medium" : "low",
      support: staleTotal,
      evidence: staleActive.map((row) => `${row.repo}: ${row.n} active session${row.n === 1 ? "" : "s"} older than 24h`),
      proposed_surface: "register-task-session skill, finish_task directive, dashboard lifecycle nudges",
      suggested_action: "Make session closure expectations sharper and consider dashboard nudges for abandoned active sessions.",
      validation_gate: "Older active sessions should decline while completed and blocked terminal states increase.",
    });
  }

  return {
    enabled: flags.enabled,
    generated_at: now(),
    summary: {
      patterns: patterns.length,
      evidence_items: patterns.reduce((sum, pattern) => sum + pattern.support, 0),
    },
    patterns,
  };
}

const HARNESS_PROPOSAL_TEMPLATES: Record<
  string,
  {
    skill_slug: string;
    title: string;
    rationale: string;
    addition: string;
    validation_gate: string;
  }
> = {
  "blocked-finish-compliance": {
    skill_slug: "run-compliance-loop",
    title: "Require fresh objective compliance evidence before claiming completion",
    rationale: "Blocked finish_task attempts indicate agents are reaching the completion step before objective coverage/drift evidence is acceptable.",
    addition:
      "Before calling finish_task, refresh objective evidence with the repo's current code-map or compliance command when available. If finish_task returns blocked, treat every outstanding item as remaining work: remediate it, rerun the targeted checks, and call finish_task again before claiming completion.",
    validation_gate: "New sessions should show fewer blocked finish attempts without reducing completed compliant sessions.",
  },
  "repeated-missing-guidance": {
    skill_slug: "resolve-uncovered-guidance",
    title: "Turn repeated uncovered topics into governed guidance work",
    rationale: "Repeated missing_guidance feedback means agents are finding the same uncovered language or domain area instead of receiving a durable governed answer.",
    addition:
      "When resolve_guidance returns an uncovered language or domain, check whether the same gap has already been reported. Prefer linking new evidence to the existing gap and propose a governed spec or styleguide acquisition path instead of creating duplicate one-off reports.",
    validation_gate: "Future resolve_guidance calls for the same topic should return governed coverage rather than a gap.",
  },
  "self-assessment-overclaim": {
    skill_slug: "collect-delivery-evidence",
    title: "Calibrate self-assessment against observed compliance evidence",
    rationale: "Large self-assessment/objective-score gaps show agents are overclaiming completion relative to measured traceability and drift evidence.",
    addition:
      "Do not assign a high self-assessed compliance score from confidence alone. Ground the score in observed tests, code-map coverage, drift results, and unresolved outstanding items; lower the score when any required evidence is missing or stale.",
    validation_gate: "The self-assessed/objective score gap should narrow without suppressing honest failed compliance reports.",
  },
  "repeated-spec-feedback": {
    skill_slug: "report-spec-problems",
    title: "Escalate recurring feedback clusters into reviewed spec or skill changes",
    rationale: "Repeated open feedback against the same guidance suggests the current stop-and-report loop is capturing confusion but not resolving it durably.",
    addition:
      "When a feedback item resembles an existing open cluster, cite the cluster and add concrete task evidence instead of filing an isolated duplicate. Treat repeated clusters as a prompt to draft a reviewed spec clarification or a narrowly scoped skill update.",
    validation_gate: "The same cluster should stop recurring after the reviewed spec or skill update is published.",
  },
  "stale-agent-sessions": {
    skill_slug: "register-task-session",
    title: "Close or block abandoned task sessions explicitly",
    rationale: "Long-lived active sessions make it unclear whether governed work completed, blocked, or continued outside the recorded SDD loop.",
    addition:
      "If work pauses, becomes blocked, or moves outside the current session, record the state explicitly with finish_task or an equivalent compliance/checkpoint call. Do not leave an active session as the only record of incomplete governed work.",
    validation_gate: "Older active sessions should decline while completed and blocked terminal states increase.",
  },
};

function harnessImprovementProposal(app: FastifyInstance, key: string) {
  const flags = getHarnessImprovementFeatureFlags(app.db);
  if (!flags.enabled || !flags.proposal_drafting) {
    throw new HttpError(403, "Harness proposal drafting is disabled");
  }
  const template = HARNESS_PROPOSAL_TEMPLATES[key];
  if (!template) throw new HttpError(404, `Unknown harness insight pattern: ${key}`);
  const skill = app.db.prepare("SELECT * FROM agent_skills WHERE slug = ?").get(template.skill_slug) as
    | {
        id: string;
        slug: string;
        name: string;
        description: string;
        instructions: string;
        risk_level: string;
        status: string;
        built_in: number;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!skill) throw new HttpError(404, `Target skill is not installed: ${template.skill_slug}`);
  const marker = "Harness improvement proposal:";
  const addition = `${marker} ${template.addition}`;
  const proposedInstructions = skill.instructions.includes(addition)
    ? skill.instructions
    : `${skill.instructions.trim()}\n\n${addition}`;
  return {
    key,
    title: template.title,
    rationale: template.rationale,
    proposal_type: "agent_skill_update",
    target_skill: {
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      risk_level: skill.risk_level,
      status: skill.status,
      built_in: Boolean(skill.built_in),
    },
    current_instructions: skill.instructions,
    proposed_instructions: proposedInstructions,
    proposed_addition: addition,
    validation_gate: template.validation_gate,
    validation: validateHarnessProposal({
      pattern_key: key,
      target_slug: skill.slug,
      title: template.title,
      current_instructions: skill.instructions,
      proposed_instructions: proposedInstructions,
      proposed_addition: addition,
      validation_gate: template.validation_gate,
      skill: skill as AgentSkillRecord,
    }),
    promotion: "review-gated; preview only, no skill was modified",
  };
}

function validateHarnessProposal(input: {
  pattern_key: string;
  target_slug: string;
  title: string;
  current_instructions: string;
  proposed_instructions: string;
  proposed_addition: string;
  validation_gate: string;
  skill: AgentSkillRecord;
}) {
  const candidateSkill: AgentSkillRecord = {
    ...input.skill,
    instructions: input.proposed_instructions,
  };
  const markdown = renderSkillMarkdown(candidateSkill);
  const checks = [
    {
      key: "renders_skill_markdown",
      passed: markdown.includes(`# ${candidateSkill.name}`) && markdown.includes("## Instructions"),
      detail: "Candidate instructions render through the governed SKILL.md template.",
    },
    {
      key: "preserves_safety_boundary",
      passed: markdown.includes("## Safety Boundary") && markdown.includes("least privilege"),
      detail: "Rendered skill keeps the standard safety boundary.",
    },
    {
      key: "bounded_edit",
      passed:
        input.proposed_instructions.startsWith(input.current_instructions.trim()) &&
        input.proposed_instructions.includes(input.proposed_addition),
      detail: "Candidate appends the proposed harness guidance without rewriting the existing skill.",
    },
    {
      key: "proposal_marker_present",
      passed: input.proposed_addition.startsWith("Harness improvement proposal:"),
      detail: "Candidate text is visibly attributable to the harness-improvement loop.",
    },
    {
      key: "pattern_specific_behavior",
      passed: patternValidationPassed(input.pattern_key, input.proposed_instructions),
      detail: "Candidate contains the behavior expected for the mined weakness pattern.",
    },
    {
      key: "core_control_terms_preserved",
      passed: coreControlTerms(input.target_slug).every((term) => input.proposed_instructions.includes(term)),
      detail: "Candidate preserves key MCP/SDD control terms for the target skill.",
    },
  ];
  return {
    status: checks.every((check) => check.passed) ? "passed" : "failed",
    checks,
    gate: input.validation_gate,
  };
}

function patternValidationPassed(patternKey: string, proposedInstructions: string): boolean {
  if (patternKey === "blocked-finish-compliance") {
    return proposedInstructions.includes("finish_task returns blocked") && proposedInstructions.includes("outstanding item");
  }
  if (patternKey === "repeated-missing-guidance") {
    return proposedInstructions.includes("uncovered language or domain") && proposedInstructions.includes("existing gap");
  }
  if (patternKey === "self-assessment-overclaim") {
    return proposedInstructions.includes("self-assessed compliance score") && proposedInstructions.includes("objective score");
  }
  if (patternKey === "repeated-spec-feedback") {
    return proposedInstructions.includes("existing open cluster") && proposedInstructions.includes("reviewed spec clarification");
  }
  if (patternKey === "stale-agent-sessions") {
    return proposedInstructions.includes("active session") && proposedInstructions.includes("finish_task");
  }
  return false;
}

function coreControlTerms(targetSlug: string): string[] {
  if (targetSlug === "run-compliance-loop") return ["finish_task"];
  if (targetSlug === "resolve-uncovered-guidance") return ["resolve_guidance", "report_spec_feedback"];
  if (targetSlug === "collect-delivery-evidence") return ["tests", "outcomes"];
  if (targetSlug === "report-spec-problems") return ["report_spec_feedback"];
  if (targetSlug === "register-task-session") return ["begin_task"];
  return [];
}

function requireHarnessProposal(app: FastifyInstance, id: string) {
  const proposal = app.db.prepare("SELECT * FROM harness_proposals WHERE id = ?").get(id) as
    | {
        id: string;
        pattern_key: string;
        title: string;
        rationale: string;
        target_type: "agent_skill";
        target_id: string;
        target_slug: string;
        current_instructions: string;
        proposed_instructions: string;
        proposed_addition: string;
        validation_gate: string;
        status: "pending" | "approved" | "rejected";
        proposed_by: string;
        reviewed_by: string | null;
        reviewed_at: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!proposal) throw new HttpError(404, `Unknown harness proposal: ${id}`);
  return proposal;
}

function validateStoredHarnessProposal(app: FastifyInstance, id: string) {
  const proposal = requireHarnessProposal(app, id);
  const skill = app.db.prepare("SELECT * FROM agent_skills WHERE id = ?").get(proposal.target_id) as AgentSkillRecord | undefined;
  if (!skill) throw new HttpError(404, `Target skill is not installed: ${proposal.target_slug}`);
  return {
    proposal_id: proposal.id,
    target_slug: proposal.target_slug,
    current_target_matches_proposal: skill.instructions === proposal.current_instructions,
    validation: validateHarnessProposal({
      pattern_key: proposal.pattern_key,
      target_slug: proposal.target_slug,
      title: proposal.title,
      current_instructions: proposal.current_instructions,
      proposed_instructions: proposal.proposed_instructions,
      proposed_addition: proposal.proposed_addition,
      validation_gate: proposal.validation_gate,
      skill,
    }),
  };
}

function createHarnessProposal(app: FastifyInstance, key: string, proposedBy: string, req: Parameters<typeof actorFrom>[0]) {
  const preview = harnessImprovementProposal(app, key);
  const id = uuid();
  const ts = now();
  app.db
    .prepare(
      `INSERT INTO harness_proposals
        (id, pattern_key, title, rationale, target_type, target_id, target_slug,
         current_instructions, proposed_instructions, proposed_addition, validation_gate,
         status, proposed_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'agent_skill', ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    )
    .run(
      id,
      key,
      preview.title,
      preview.rationale,
      preview.target_skill.id,
      preview.target_skill.slug,
      preview.current_instructions,
      preview.proposed_instructions,
      preview.proposed_addition,
      preview.validation_gate,
      proposedBy,
      ts,
      ts
    );
  recordAudit(app.db, {
    actor: actorFrom(req, proposedBy),
    action: "harness_proposal.submitted",
    target_type: "harness_proposal",
    target_id: id,
    summary: `Harness proposal submitted for ${preview.target_skill.slug}`,
    detail: { pattern_key: key, target_slug: preview.target_skill.slug, validation_gate: preview.validation_gate },
  });
  return requireHarnessProposal(app, id);
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // --- Feature controls ---

  app.get("/features/config", async () => {
    return getFeatureConfig(app.db);
  });

  app.get("/features/harness-insights", async () => harnessImprovementInsights(app));

  app.post("/features/harness-insights/:key/proposal", async (req) => {
    const { key } = req.params as { key: string };
    return harnessImprovementProposal(app, key);
  });

  app.post("/features/harness-insights/:key/proposals", async (req, reply) => {
    const { key } = req.params as { key: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const proposedBy = typeof body.proposed_by === "string" && body.proposed_by.trim()
      ? body.proposed_by.trim()
      : req.user?.username ?? "harness-improvement";
    const proposal = createHarnessProposal(app, key, proposedBy, req);
    reply.code(201);
    return proposal;
  });

  app.get("/features/harness-proposals", async (req) => {
    const { status } = req.query as { status?: string };
    const params: unknown[] = [];
    const where = status && ["pending", "approved", "rejected"].includes(status) ? "WHERE hp.status = ?" : "";
    if (where) params.push(status);
    return app.db
      .prepare(
        `SELECT hp.*, ask.name AS target_name, ask.risk_level AS target_risk_level, ask.status AS target_status
         FROM harness_proposals hp
         JOIN agent_skills ask ON ask.id = hp.target_id
         ${where}
         ORDER BY hp.created_at DESC`
      )
      .all(...params);
  });

  app.post("/features/harness-proposals/:id/validate", async (req) => {
    const { id } = req.params as { id: string };
    return validateStoredHarnessProposal(app, id);
  });

  app.post("/features/harness-proposals/:id/approve", async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reviewedBy = requireString(body, "reviewed_by");
    const proposal = requireHarnessProposal(app, id);
    if (proposal.status !== "pending") throw new HttpError(409, `Harness proposal already ${proposal.status}`);
    const actor = (req.user?.username ?? reviewedBy).trim().toLowerCase();
    const proposer = proposal.proposed_by.trim().toLowerCase();
    if (actor && proposer && actor === proposer) {
      const allowAdminSelfApprove =
        process.env.SPECREG_ALLOW_ADMIN_SELF_APPROVE === "true" ||
        (app.db.prepare("SELECT value FROM settings WHERE key = 'allow_admin_self_approve'").get() as
          | { value?: string }
          | undefined)?.value === "true";
      if (!(req.user?.role === "admin" && allowAdminSelfApprove)) {
        throw new HttpError(403, "Separation of duties: a different reviewer must approve this harness proposal.");
      }
    }
    const skill = app.db.prepare("SELECT id, slug, instructions FROM agent_skills WHERE id = ?").get(proposal.target_id) as
      | { id: string; slug: string; instructions: string }
      | undefined;
    if (!skill) throw new HttpError(404, `Target skill is not installed: ${proposal.target_slug}`);
    if (skill.instructions !== proposal.current_instructions) {
      throw new HttpError(409, "Target skill changed after this proposal was created; regenerate the proposal before approving.");
    }
    const flags = getHarnessImprovementFeatureFlags(app.db);
    if (flags.regression_validation) {
      const validation = validateStoredHarnessProposal(app, proposal.id);
      if (!validation.current_target_matches_proposal || validation.validation.status !== "passed") {
        throw new HttpError(409, "Harness proposal failed regression validation; fix or regenerate it before approving.");
      }
    }
    const ts = now();
    const approve = app.db.transaction(() => {
      app.db
        .prepare("UPDATE agent_skills SET instructions = ?, updated_at = ? WHERE id = ?")
        .run(proposal.proposed_instructions, ts, proposal.target_id);
      app.db
        .prepare("UPDATE harness_proposals SET status = 'approved', reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
        .run(reviewedBy, ts, ts, proposal.id);
    });
    approve();
    recordAudit(app.db, {
      actor: actorFrom(req, reviewedBy),
      action: "harness_proposal.approved",
      target_type: "harness_proposal",
      target_id: proposal.id,
      summary: `Harness proposal approved for ${proposal.target_slug}`,
      detail: { pattern_key: proposal.pattern_key, target_slug: proposal.target_slug },
    });
    return requireHarnessProposal(app, proposal.id);
  });

  app.post("/features/harness-proposals/:id/reject", async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reviewedBy = requireString(body, "reviewed_by");
    const proposal = requireHarnessProposal(app, id);
    if (proposal.status !== "pending") throw new HttpError(409, `Harness proposal already ${proposal.status}`);
    const ts = now();
    app.db
      .prepare("UPDATE harness_proposals SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
      .run(reviewedBy, ts, ts, proposal.id);
    recordAudit(app.db, {
      actor: actorFrom(req, reviewedBy),
      action: "harness_proposal.rejected",
      target_type: "harness_proposal",
      target_id: proposal.id,
      summary: `Harness proposal rejected for ${proposal.target_slug}`,
      detail: { pattern_key: proposal.pattern_key, target_slug: proposal.target_slug },
    });
    return requireHarnessProposal(app, proposal.id);
  });

  app.put("/features/config", async (req) => {
    const body = (req.body ?? {}) as Partial<Pick<FeatureConfig, "automation" | "code_metadata" | "harness_improvement">>;
    const saved = saveFeatureConfig(app.db, body);
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "features.config.updated",
      target_type: "features",
      summary: "Feature settings updated",
      detail: { automation: saved.automation, code_metadata: saved.code_metadata, harness_improvement: saved.harness_improvement },
    });
    return saved;
  });

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
    const route = isLlmRoute(body.route) ? body.route : "test";
    const tier = isLlmTier(body.tier) ? body.tier : undefined;
    const result = await runLlmText(app.db, {
      system: "You are a connectivity test for SpecRegistry. Reply briefly.",
      user: prompt,
      maxTokens,
      route,
      tier,
    });
    return { ok: true, provider: result.provider, model: result.model, tier: result.tier, route: result.route, text: result.text, max_tokens: maxTokens };
  });

  app.get("/llm/models", async () => {
    return listLlmModels(app.db);
  });

  app.get("/llm/tiering", async () => {
    return publicLlmTieringConfig(app.db);
  });

  app.put("/llm/tiering/tier/:tier", async (req) => {
    const { tier } = req.params as { tier: string };
    if (!isLlmTier(tier)) throw new HttpError(400, "tier must be cheap, standard, or frontier");
    const body = (req.body ?? {}) as Partial<LlmConfig> & { clear_api_key?: boolean };
    const saved = publicLlmTierConfig(app.db, tier, saveLlmTierConfig(app.db, tier, body));
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "llm.tier.updated",
      target_type: "llm",
      target_id: tier,
      summary: `${saved.label} LLM tier updated`,
      detail: { tier, provider: saved.provider, model: saved.model, base_url: saved.base_url, has_api_key: saved.has_api_key },
    });
    return saved;
  });

  app.put("/llm/tiering/routes", async (req) => {
    const body = (req.body ?? {}) as { routes?: Partial<Record<LlmTaskRoute, LlmTier>> };
    const requested = body.routes ?? {};
    for (const [route, tier] of Object.entries(requested)) {
      if (!isLlmRoute(route)) throw new HttpError(400, `unknown LLM route: ${route}`);
      if (!isLlmTier(tier)) throw new HttpError(400, `route ${route} must map to cheap, standard, or frontier`);
    }
    const routes = saveLlmRoutes(app.db, requested);
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "llm.routes.updated",
      target_type: "llm",
      summary: "LLM feature routing updated",
      detail: routes,
    });
    return { routes };
  });

  app.get("/llm/models/:tier", async (req) => {
    const { tier } = req.params as { tier: string };
    if (!isLlmTier(tier)) throw new HttpError(400, "tier must be cheap, standard, or frontier");
    return listLlmModels(app.db, tier);
  });

  // --- Embedding provider settings for semantic search ---

  app.get("/embeddings/config", async () => {
    return publicEmbeddingConfig(app.db);
  });

  app.put("/embeddings/config", async (req) => {
    const body = (req.body ?? {}) as Partial<EmbeddingConfig> & { clear_api_key?: boolean };
    const saved = publicEmbeddingConfig(app.db, saveEmbeddingConfig(app.db, body));
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "embeddings.config.updated",
      target_type: "embeddings",
      summary: "Embedding configuration updated",
      detail: { provider: saved.provider, model: saved.model, base_url: saved.base_url, dimensions: saved.dimensions, has_api_key: saved.has_api_key },
    });
    return saved;
  });

  app.get("/embeddings/status", async () => {
    return semanticIndexStatus(app.db);
  });

  app.post("/embeddings/reindex", async (req) => {
    const result = await reindexSemanticAll(app.db);
    const status = semanticIndexStatus(app.db);
    recordAudit(app.db, {
      actor: actorFrom(req, "settings"),
      action: "embeddings.reindexed",
      target_type: "embeddings",
      summary: `Semantic index rebuilt: ${result.indexed_sections} section(s) updated`,
      detail: result,
    });
    return { ...result, status };
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

  app.get("/spec-ownership", async () => {
    const policies = app.db
      .prepare(
        `SELECT ap.*, pt.name AS project_type_name
         FROM approval_policies ap
         LEFT JOIN project_types pt ON pt.id = ap.project_type_id
         ORDER BY ap.project_type_id IS NULL ASC, LENGTH(ap.filename_glob) DESC, ap.created_at DESC`
      )
      .all() as Array<Record<string, unknown> & { id: string; project_type_id: string | null; filename_glob: string; required_reviewers: string }>;
    const specs = app.db
      .prepare(
        `SELECT s.id, s.filename, s.project_type_id, pt.name AS project_type_name
         FROM specs s JOIN project_types pt ON pt.id = s.project_type_id
         WHERE s.deleted_at IS NULL
         ORDER BY pt.name, s.filename`
      )
      .all() as Array<{ id: string; filename: string; project_type_id: string; project_type_name: string }>;
    const ownership = specs.map((spec) => {
      const policy = policies.find(
        (candidate) =>
          (!candidate.project_type_id || candidate.project_type_id === spec.project_type_id) &&
          (candidate.filename_glob === "*" ||
            spec.filename.toLowerCase().startsWith(String(candidate.filename_glob).replace(/\*.*$/, "").toLowerCase()))
      );
      return {
        ...spec,
        policy_id: policy?.id ?? null,
        owners: policy ? (JSON.parse(policy.required_reviewers) as string[]) : [],
      };
    });
    return { policies, ownership };
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
         WHERE s.status = 'published' AND s.deleted_at IS NULL AND s.updated_at < ?
         ORDER BY s.updated_at LIMIT 10`
      )
      .all(staleCutoff);

    return { window_days: 30, events: byType, top_project_types: topTypes, stale_specs: stale };
  });

  // --- Compliance policies (per-project-type thresholds for the verification loop) ---

  app.get("/compliance-policies", async () => {
    const rows = app.db
      .prepare(
        `SELECT cp.*, pt.name AS project_type_name
         FROM compliance_policies cp
         LEFT JOIN project_types pt ON pt.id = cp.project_type_id
         ORDER BY cp.project_type_id IS NULL DESC, pt.name`
      )
      .all();
    return { default: DEFAULT_COMPLIANCE_POLICY, policies: rows };
  });

  app.put("/compliance-policies", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pt = body.project_type ? requireProjectType(app.db, requireString(body, "project_type")) : undefined;
    const minCoverage = typeof body.min_coverage === "number" ? body.min_coverage : DEFAULT_COMPLIANCE_POLICY.min_coverage;
    const maxDrift = typeof body.max_drift === "number" ? body.max_drift : DEFAULT_COMPLIANCE_POLICY.max_drift;
    const kinds = Array.isArray(body.required_mapped_kinds)
      ? (body.required_mapped_kinds as unknown[]).filter((k): k is string => typeof k === "string")
      : DEFAULT_COMPLIANCE_POLICY.required_mapped_kinds;
    if (minCoverage < 0 || minCoverage > 1 || maxDrift < 0 || maxDrift > 1) {
      throw new HttpError(400, "min_coverage and max_drift must be between 0 and 1");
    }
    const ts = now();
    const existing = app.db
      .prepare("SELECT id FROM compliance_policies WHERE project_type_id IS ?")
      .get(pt?.id ?? null) as { id: string } | undefined;
    if (existing) {
      app.db
        .prepare("UPDATE compliance_policies SET min_coverage = ?, max_drift = ?, required_mapped_kinds = ?, updated_at = ? WHERE id = ?")
        .run(minCoverage, maxDrift, JSON.stringify(kinds), ts, existing.id);
    } else {
      app.db
        .prepare(
          `INSERT INTO compliance_policies (id, project_type_id, min_coverage, max_drift, required_mapped_kinds, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(uuid(), pt?.id ?? null, minCoverage, maxDrift, JSON.stringify(kinds), ts, ts);
    }
    recordAudit(app.db, {
      actor: actorFrom(req, "admin"),
      action: "compliance_policy.updated",
      target_type: "compliance_policy",
      target_id: pt?.id ?? "default",
      summary: `Compliance policy set for ${pt?.name ?? "default"}: coverage>=${minCoverage}, drift<=${maxDrift}`,
      detail: { project_type: pt?.name ?? null, min_coverage: minCoverage, max_drift: maxDrift, required_mapped_kinds: kinds },
    });
    return getCompliancePolicy(app.db, pt?.id ?? null);
  });

  // The compliance attempt log — the self-healing loop trail (newest first).
  app.get("/compliance-attestations", async (req) => {
    const { repo } = req.query as { repo?: string };
    const base = `
      SELECT ca.*, pt.name AS project_type_name
      FROM compliance_attestations ca
      LEFT JOIN project_types pt ON pt.id = ca.project_type_id
    `;
    return repo
      ? app.db.prepare(`${base} WHERE ca.repo = ? ORDER BY ca.created_at DESC LIMIT 200`).all(repo)
      : app.db.prepare(`${base} ORDER BY ca.created_at DESC LIMIT 200`).all();
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
         WHERE s.deleted_at IS NULL
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
         LEFT JOIN specs s ON s.project_type_id = pt.id AND s.deleted_at IS NULL
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
                END) AS outdated_specs,
                ctr.id AS code_trace_report_id,
                ctr.coverage_ratio AS code_coverage_ratio,
                ctr.drift_score AS code_drift_score,
                ctr.drift_severity AS code_drift_severity,
                ctr.linked_entity_count AS code_linked_entity_count,
                ctr.governed_entity_count AS code_governed_entity_count,
                ctr.unlinked_entity_count AS code_unlinked_entity_count,
                ctr.created_at AS code_trace_reported_at
         FROM repo_consumers rc
         JOIN project_types pt ON pt.id = rc.project_type_id
         LEFT JOIN repo_consumer_specs rcs ON rcs.consumer_id = rc.id
         LEFT JOIN specs ps ON ps.project_id = rc.id AND ps.deleted_at IS NULL
         LEFT JOIN specs s ON s.deleted_at IS NULL AND (s.project_id = rc.id OR (s.project_id IS NULL AND (s.project_type_id = rc.project_type_id OR s.project_type_id IN (SELECT id FROM project_types WHERE scope = 'global'))))
         LEFT JOIN agent_feedback af ON af.spec_id = ps.id
         LEFT JOIN change_requests cr ON cr.spec_id = ps.id
         LEFT JOIN code_trace_reports ctr ON ctr.id = (
           SELECT id FROM code_trace_reports latest
           WHERE latest.consumer_id = rc.id
           ORDER BY latest.created_at DESC
           LIMIT 1
         )
         GROUP BY rc.id
         ORDER BY rc.last_seen_at DESC, rc.repo`
      )
      .all();

    const codeTraceReports = app.db
      .prepare(
        `SELECT ctr.id, ctr.consumer_id, rc.repo, rc.branch, pt.name AS project_type_name,
                ctr.generated_at, ctr.specs_dir, ctr.spec_count, ctr.entity_count,
                ctr.governed_entity_count, ctr.linked_entity_count, ctr.unlinked_entity_count,
                ctr.coverage_ratio, ctr.drift_score, ctr.drift_severity,
                ctr.aliases_count, ctr.unlinked_sample, ctr.created_at,
                COUNT(ctl.entity_id) AS link_count
         FROM code_trace_reports ctr
         JOIN repo_consumers rc ON rc.id = ctr.consumer_id
         JOIN project_types pt ON pt.id = rc.project_type_id
         LEFT JOIN code_trace_links ctl ON ctl.report_id = ctr.id
         WHERE ctr.id IN (
           SELECT id FROM code_trace_reports latest
           WHERE latest.consumer_id = ctr.consumer_id
           ORDER BY latest.created_at DESC
           LIMIT 1
         )
         GROUP BY ctr.id
         ORDER BY ctr.drift_score DESC, ctr.coverage_ratio ASC, ctr.created_at DESC`
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
         WHERE pt.scope = 'global' AND s.project_id IS NULL AND s.deleted_at IS NULL
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
      code_trace_reports: codeTraceReports,
      global_specs: globalSpecs,
    };
  });

  // Self-update: git pull --ff-only + rebuild for a deployment running from a live
  // checkout. Refuses on a dirty tree or a non-fast-forward pull rather than guessing
  // at a merge, and does not restart the process — Node cannot safely hot-swap its own
  // already-loaded modules, so a manual (or process-manager) restart is still required.
  app.post("/admin/update", async (req) => {
    try {
      const result = await pullAndRebuild();
      recordAudit(app.db, {
        actor: actorFrom(req, "admin"),
        action: "server.update_pulled",
        summary: result.updated ? `Server pulled ${result.previous_sha}..${result.new_sha} and rebuilt` : "Server already up to date",
        detail: {
          previous_sha: result.previous_sha,
          new_sha: result.new_sha,
          updated: result.updated,
          dependencies_installed: result.dependencies_installed,
        },
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Update failed";
      recordAudit(app.db, {
        actor: actorFrom(req, "admin"),
        action: "server.update_failed",
        summary: `Server update attempt failed: ${message.split("\n")[0]}`,
      });
      throw new HttpError(409, message);
    }
  });
}
