import type { FastifyInstance } from "fastify";
import type { Spec } from "@specregistry/shared";
import { now, uuid } from "../db.js";
import { HttpError, requireProjectType, requireString } from "../helpers.js";
import { actorFrom, recordAudit } from "../lib/auditLog.js";
import { bundleSpecs } from "../lib/compile.js";
import { recordUsage } from "../lib/events.js";
import { runLlmText } from "../lib/llm.js";
import {
  auditPromptForSpec,
  classifySpecSections,
  composeSpecPack,
  detectSpecGaps,
  deterministicSpecDraft,
  improvementSuggestions,
  optimizeContext,
  planTaskContext,
  purposePrompt,
  PURPOSE_TEMPLATES,
  ticketChecklist,
  type AutomationSpecInput,
} from "../lib/specAutomation.js";

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function requirePurpose(id: string) {
  const purpose = PURPOSE_TEMPLATES.find((item) => item.id === id || item.filename.toLowerCase() === id.toLowerCase());
  if (!purpose) throw new HttpError(404, `Unknown spec purpose: ${id}`);
  return purpose;
}

const FLAG_ENV: Record<string, string> = {
  enabled: "SPECREG_AUTOMATION_ENABLED",
  gap_detection: "SPECREG_AUTOMATION_GAP_DETECTION",
  generation: "SPECREG_AUTOMATION_GENERATION",
  llm_generation: "SPECREG_AUTOMATION_LLM_GENERATION",
  task_planner: "SPECREG_AUTOMATION_TASK_PLANNER",
  ticket_generator: "SPECREG_AUTOMATION_TICKET_GENERATOR",
  maintenance: "SPECREG_AUTOMATION_MAINTENANCE",
  pack_composer: "SPECREG_AUTOMATION_PACK_COMPOSER",
  audit_prompts: "SPECREG_AUTOMATION_AUDIT_PROMPTS",
  section_classifier: "SPECREG_AUTOMATION_SECTION_CLASSIFIER",
  context_optimizer: "SPECREG_AUTOMATION_CONTEXT_OPTIMIZER",
};

function flagValue(name: keyof typeof FLAG_ENV): boolean {
  const value = process.env[FLAG_ENV[name]];
  if (value === undefined) return true;
  return !["0", "false", "off", "no"].includes(value.toLowerCase());
}

function automationFlags() {
  const enabled = flagValue("enabled");
  return Object.fromEntries(
    Object.keys(FLAG_ENV).map((key) => [key, enabled && (key === "enabled" ? true : flagValue(key as keyof typeof FLAG_ENV))])
  ) as Record<keyof typeof FLAG_ENV, boolean>;
}

function requireFeature(name: keyof typeof FLAG_ENV): void {
  const flags = automationFlags();
  if (!flags.enabled || !flags[name]) throw new HttpError(403, `Automation feature disabled: ${name}`);
}

function governedSpecs(app: FastifyInstance, projectTypeName: string): AutomationSpecInput[] {
  const pt = requireProjectType(app.db, projectTypeName);
  return bundleSpecs(app.db, pt.id).map((spec) => ({
    id: spec.id,
    filename: spec.filename,
    content: spec.content,
    current_version: spec.current_version,
  }));
}

const MAX_GUIDANCE_LENGTH = 2000;

async function buildAuditPrompt(app: FastifyInstance, spec: AutomationSpecInput, useLlm: boolean, customGuidance?: string) {
  let prompt = auditPromptForSpec(spec);
  if (useLlm) {
    requireFeature("llm_generation");
    let userMsg = prompt;
    if (customGuidance && customGuidance.trim()) {
      const trimmed = customGuidance.trim().slice(0, MAX_GUIDANCE_LENGTH);
      userMsg += `\n\nCustom Guidance / Specific Focus:\n${trimmed}`;
    }
    const llm = await runLlmText(app.db, {
      system: "You improve reverse-conformance audit prompts. Integrate the user's custom guidance and focus into the prompt if provided. Output only the improved prompt.",
      user: userMsg,
      maxTokens: 2500,
      route: "audit",
    });
    return { prompt: llm.text, model: llm.model, provider: llm.provider };
  }
  return { prompt, model: null, provider: null };
}

export async function automationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/automation/features", async () => automationFlags());

  app.get("/spec-purposes", async () => PURPOSE_TEMPLATES);

  app.post("/spec-gaps", async (req) => {
    requireFeature("gap_detection");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectTypeName = requireString(body, "project_type");
    const pt = requireProjectType(app.db, projectTypeName);
    const tree = typeof body.tree === "string" ? body.tree : "";
    const existingSpecs =
      stringArray(body.existing_specs).length > 0
        ? stringArray(body.existing_specs)
        : (app.db
            .prepare("SELECT filename FROM specs WHERE project_type_id = ? OR project_type_id IN (SELECT id FROM project_types WHERE scope = 'global')")
            .all(pt.id) as Array<{ filename: string }>).map((row) => row.filename);
    recordUsage(app.db, "stub_prompts", pt.id, "spec-gaps");
    return {
      project_type: pt.name,
      gaps: detectSpecGaps({
        tree,
        existingSpecs,
        detectedLanguages: stringArray(body.detected_languages),
      }),
    };
  });

  app.post("/spec-generation/preview", async (req) => {
    requireFeature("generation");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectTypeName = requireString(body, "project_type");
    const purpose = requirePurpose(requireString(body, "purpose"));
    const pt = requireProjectType(app.db, projectTypeName);
    const tree = typeof body.tree === "string" ? body.tree : "";
    const detectedLanguages = stringArray(body.detected_languages);
    const prompt = purposePrompt({
      purpose,
      projectType: pt.name,
      tree,
      detectedLanguages,
      extraContext: typeof body.extra_context === "string" ? body.extra_context : undefined,
    });
    const useLlm = body.use_llm === true;
    if (useLlm) requireFeature("llm_generation");
    const generated = useLlm
      ? await runLlmText(app.db, {
          system: "You generate complete Markdown specification documents. Output only Markdown.",
          user: prompt,
          route: "spec_generation",
        })
      : null;
    return {
      project_type: pt.name,
      purpose,
      filename: purpose.filename,
      prompt,
      content: generated?.text ?? deterministicSpecDraft({ purpose, projectType: pt.name, tree, detectedLanguages }),
      model: generated?.model ?? null,
      provider: generated?.provider ?? null,
    };
  });

  app.post("/spec-generation/draft", async (req, reply) => {
    requireFeature("generation");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectTypeName = requireString(body, "project_type");
    const purpose = requirePurpose(requireString(body, "purpose"));
    const pt = requireProjectType(app.db, projectTypeName);
    const filename = typeof body.filename === "string" && body.filename.trim() ? body.filename.trim() : purpose.filename;
    const content = requireString(body, "content");
    const updatedBy = typeof body.updated_by === "string" && body.updated_by.trim() ? body.updated_by.trim() : "spec-generation";
    const duplicate = app.db
      .prepare("SELECT id FROM specs WHERE project_type_id = ? AND project_id IS NULL AND filename = ?")
      .get(pt.id, filename);
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
         VALUES (?, ?, NULL, ?, '0.1.0', 'draft', ?, ?, ?, ?, ?)`
      )
      .run(id, pt.id, filename, content, updatedBy, auditPrompt, ts, ts);
    recordAudit(app.db, {
      actor: actorFrom(req, updatedBy),
      action: "spec.generated_draft",
      target_type: "spec",
      target_id: id,
      summary: `Generated draft ${filename} from purpose ${purpose.id}`,
      detail: { project_type: pt.name, purpose: purpose.id },
    });
    reply.code(201);
    return app.db.prepare("SELECT * FROM specs WHERE id = ?").get(id) as Spec;
  });

  app.post("/automation/task-plan", async (req) => {
    requireFeature("task_planner");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectTypeName = requireString(body, "project_type");
    const task = requireString(body, "task");
    const tree = typeof body.tree === "string" ? body.tree : "";
    const specs = governedSpecs(app, projectTypeName);
    const plan = planTaskContext({
      task,
      tree,
      specs,
      existingSpecs: specs.map((spec) => spec.filename),
      tokenBudget: Number(body.token_budget ?? 2000),
    });
    if (body.use_llm === true) {
      requireFeature("llm_generation");
      const llm = await runLlmText(app.db, {
        system: "You are an SDD planning assistant. Improve the deterministic task plan without inventing unavailable specs.",
        user: JSON.stringify(plan, null, 2),
        maxTokens: 3000,
        route: "task_planning",
      });
      return { ...plan, llm_notes: llm.text, model: llm.model, provider: llm.provider };
    }
    return plan;
  });

  app.post("/automation/ticket", async (req) => {
    requireFeature("ticket_generator");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectTypeName = requireString(body, "project_type");
    const task = requireString(body, "task");
    const tree = typeof body.tree === "string" ? body.tree : "";
    const specs = governedSpecs(app, projectTypeName);
    const plan = planTaskContext({ task, tree, specs, existingSpecs: specs.map((spec) => spec.filename) });
    let markdown = ticketChecklist({ task, plan });
    if (body.use_llm === true) {
      requireFeature("llm_generation");
      const llm = await runLlmText(app.db, {
        system: "You write concise implementation tickets from SDD plans. Output Markdown only.",
        user: markdown,
        maxTokens: 3000,
        route: "ticket_generation",
      });
      markdown = llm.text;
    }
    return { markdown, plan };
  });

  app.post("/automation/section-classifier", async (req) => {
    requireFeature("section_classifier");
    const body = (req.body ?? {}) as Record<string, unknown>;
    return { sections: classifySpecSections(governedSpecs(app, requireString(body, "project_type"))) };
  });

  app.post("/automation/context-budget", async (req) => {
    requireFeature("context_optimizer");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const task = typeof body.task === "string" ? body.task : "";
    const specs = governedSpecs(app, requireString(body, "project_type"));
    const plan = planTaskContext({ task, tree: "", specs, tokenBudget: Number(body.token_budget ?? 2000) });
    return optimizeContext({ sections: plan.sections, tokenBudget: Number(body.token_budget ?? 2000) });
  });

  app.post("/automation/audit-prompt", async (req) => {
    requireFeature("audit_prompts");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const specId = requireString(body, "spec_id");
    const spec = app.db.prepare("SELECT * FROM specs WHERE id = ?").get(specId) as AutomationSpecInput | undefined;
    if (!spec) throw new HttpError(404, `Unknown spec: ${specId}`);
    const customGuidance = typeof body.custom_guidance === "string" ? body.custom_guidance : undefined;
    const result = await buildAuditPrompt(app, spec, body.use_llm === true, customGuidance);
    
    // Save generated prompt to database
    app.db
      .prepare("UPDATE specs SET audit_prompt = ?, updated_at = ? WHERE id = ?")
      .run(result.prompt, now(), spec.id);

    return { spec_id: spec.id, filename: spec.filename, ...result };
  });

  app.get("/automation/audit-prompt/:specId", async (req) => {
    requireFeature("audit_prompts");
    const { specId } = req.params as { specId: string };
    const spec = app.db.prepare("SELECT * FROM specs WHERE id = ?").get(specId) as (AutomationSpecInput & { audit_prompt?: string | null }) | undefined;
    if (!spec) throw new HttpError(404, `Unknown spec: ${specId}`);

    // Read-only: return the saved prompt or generate a deterministic baseline (no DB write)
    const prompt = spec.audit_prompt || auditPromptForSpec(spec);
    return {
      spec_id: spec.id,
      filename: spec.filename,
      version: spec.current_version,
      prompt,
      model: null,
      provider: null,
    };
  });

  app.put("/automation/audit-prompt/:specId", async (req) => {
    requireFeature("audit_prompts");
    const { specId } = req.params as { specId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prompt = requireString(body, "prompt");
    const spec = app.db.prepare("SELECT * FROM specs WHERE id = ?").get(specId) as AutomationSpecInput | undefined;
    if (!spec) throw new HttpError(404, `Unknown spec: ${specId}`);

    app.db
      .prepare("UPDATE specs SET audit_prompt = ?, updated_at = ? WHERE id = ?")
      .run(prompt, now(), spec.id);

    recordAudit(app.db, {
      actor: actorFrom(req, "audit-prompt"),
      action: "spec.audit_prompt_updated",
      target_type: "spec",
      target_id: spec.id,
      summary: `Audit prompt updated for ${spec.filename}`,
      detail: undefined,
    });

    return { success: true, spec_id: spec.id, prompt };
  });

  app.get("/automation/audit-prompts", async (req) => {
    requireFeature("audit_prompts");
    const { project_type } = req.query as { project_type?: string };
    const specs = project_type
      ? governedSpecs(app, project_type)
      : (app.db.prepare("SELECT * FROM specs WHERE status = 'published' AND deleted_at IS NULL ORDER BY filename").all() as AutomationSpecInput[]);
    return {
      project_type: project_type ?? null,
      prompts: specs.map((spec) => ({
        spec_id: spec.id,
        filename: spec.filename,
        version: spec.current_version,
        prompt: auditPromptForSpec(spec),
      })),
    };
  });

  app.post("/automation/improvement-suggestions", async (req) => {
    requireFeature("maintenance");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const specs = governedSpecs(app, requireString(body, "project_type"));
    const feedback = app.db.prepare("SELECT spec_id, error_type, description, status FROM agent_feedback").all() as Array<{
      spec_id: string;
      error_type: string;
      description: string;
      status: string;
    }>;
    const roi = app.db
      .prepare(
        `SELECT s.id AS spec_id,
                COUNT(DISTINCT CASE WHEN af.status = 'open' THEN af.id END) AS open_feedback,
                COALESCE(AVG(er.score_with - er.score_without), 0) AS avg_lift
         FROM specs s
         LEFT JOIN agent_feedback af ON af.spec_id = s.id
         LEFT JOIN efficacy_runs er ON er.spec_id = s.id
         GROUP BY s.id`
      )
      .all() as Array<{ spec_id: string; open_feedback: number; avg_lift: number }>;
    const suggestions = improvementSuggestions({
        specs,
        feedback,
        roi: roi.map((row) => ({
          spec_id: row.spec_id,
          open_feedback: Number(row.open_feedback),
          roi_score: Number(row.avg_lift) - Number(row.open_feedback),
        })),
      });
    if (body.use_llm === true) {
      requireFeature("llm_generation");
      const llm = await runLlmText(app.db, {
        system: "You turn deterministic spec improvement findings into concise prioritized recommendations. Output Markdown only.",
        user: JSON.stringify(suggestions, null, 2),
        maxTokens: 3000,
        route: "maintenance",
      });
      return { suggestions, llm_notes: llm.text, model: llm.model, provider: llm.provider };
    }
    return { suggestions };
  });

  app.post("/automation/spec-pack", async (req) => {
    requireFeature("pack_composer");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = stringArray(body.purposes);
    const purposes = ids.length > 0 ? ids.map(requirePurpose) : PURPOSE_TEMPLATES;
    const pack = composeSpecPack({ name: typeof body.name === "string" ? body.name : "Custom Spec Pack", purposes });
    if (body.use_llm === true) {
      requireFeature("llm_generation");
      const llm = await runLlmText(app.db, {
        system: "You write a concise README for a reusable SpecRegistry spec pack. Output Markdown only.",
        user: JSON.stringify({ name: pack.name, files: pack.specs.map((spec) => spec.filename) }, null, 2),
        maxTokens: 2000,
        route: "spec_generation",
      });
      return { ...pack, readme: llm.text, model: llm.model, provider: llm.provider };
    }
    return pack;
  });
}
