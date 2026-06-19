import type { ProjectType } from "@specregistry/shared";
import type { Db } from "../db.js";
import { HttpError } from "../helpers.js";
import { bundleSpecs } from "./compile.js";
import { runLlmText, type LlmTaskRoute } from "./llm.js";

export interface AuditFinding {
  severity: "high" | "medium" | "low";
  spec: string;
  section: string;
  file: string;
  description: string;
  recommendation: string;
}

export interface AuditInput {
  tree: string;
  files: Array<{ path: string; content: string }>;
}

/** Pull a JSON object out of a model response, tolerating code fences and prose. */
export function extractJson<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new HttpError(502, "Model response contained no JSON object");
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

async function runConfiguredLlm(
  db: Db,
  system: string,
  user: string,
  maxTokens = 16000,
  route: LlmTaskRoute = "audit"
): Promise<{ text: string; model: string }> {
  const result = await runLlmText(db, { system, user, maxTokens, route });
  return { text: result.text, model: result.model };
}

/** Reverse conformance: does this codebase follow its governed specs? */
export async function auditCodebase(db: Db, pt: ProjectType, input: AuditInput): Promise<AuditFinding[]> {
  const specs = bundleSpecs(db, pt.id);
  const specBlock = specs
    .map((s) => `<spec filename="${s.filename}" version="${s.current_version}">\n${s.content}\n</spec>`)
    .join("\n\n");
  const fileBlock = input.files
    .map((f) => `<file path="${f.path}">\n${f.content}\n</file>`)
    .join("\n\n");

  const system = `You are a conformance auditor for SpecRegistry. You receive an organization's governed
specification documents and a snapshot of a codebase (directory tree plus selected files). Report every
place the codebase violates, contradicts, or ignores a requirement stated in the specifications.

Rules:
- Only report violations of requirements that are explicitly stated in the provided specs.
- Cite the spec filename and the section heading the requirement comes from.
- Cite the file (or "(repo-wide)") where the violation occurs.
- severity: "high" for security or correctness violations, "medium" for structural/process violations, "low" for style.
- If the provided snapshot is insufficient to evaluate a requirement, do not guess — omit it.
- Output ONLY a JSON object: {"findings": [{"severity", "spec", "section", "file", "description", "recommendation"}]}.
- An empty findings array is a valid and common result.`;

  const user = `## Governed specifications (project type: ${pt.name})

${specBlock}

## Codebase snapshot

### Directory tree
\`\`\`
${input.tree}
\`\`\`

### Selected files
${fileBlock}`;

  const raw = (await runConfiguredLlm(db, system, user, 16000, "audit")).text;
  const parsed = extractJson<{ findings?: AuditFinding[] }>(raw);
  return Array.isArray(parsed.findings) ? parsed.findings : [];
}

export interface EfficacyResult {
  score_with: number;
  score_without: number;
  improved: boolean;
  rationale: string;
  model: string;
}

/**
 * Spec efficacy A/B: generate a response to the task with and without the spec in
 * context, then grade both against the spec's requirements. Measures whether the
 * spec actually changes agent output.
 */
export async function runEfficacy(db: Db, specContent: string, specFilename: string, task: string): Promise<EfficacyResult> {
  const baseSystem = "You are an engineer completing the task you are given. Be concrete and produce real output (code, config, or a plan as appropriate). Keep it under 600 words.";
  const [withSpec, withoutSpec] = await Promise.all([
    runConfiguredLlm(
      db,
      `${baseSystem}\n\nYou MUST follow this governing specification (${specFilename}):\n\n${specContent}`,
      task,
      4000,
      "efficacy"
    ),
    runConfiguredLlm(db, baseSystem, task, 4000, "efficacy"),
  ]);

  const judgeSystem = `You are grading how well two anonymous responses to the same task adhere to a governing
specification. Score each 0-100 for adherence to the specification's explicit requirements (not general quality).
Output ONLY JSON: {"score_a": n, "score_b": n, "rationale": "one short paragraph comparing them against specific spec requirements"}.`;
  const judgeUser = `## Specification (${specFilename})
${specContent}

## Task
${task}

## Response A
${withSpec.text}

## Response B
${withoutSpec.text}`;

  const verdict = extractJson<{ score_a: number; score_b: number; rationale: string }>(
    (await runConfiguredLlm(db, judgeSystem, judgeUser, 4000, "efficacy")).text
  );
  return {
    score_with: verdict.score_a,
    score_without: verdict.score_b,
    improved: verdict.score_a > verdict.score_b,
    rationale: verdict.rationale,
    model: withSpec.model,
  };
}
