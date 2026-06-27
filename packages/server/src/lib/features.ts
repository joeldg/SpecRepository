import type { Db } from "../db.js";

export const AUTOMATION_FEATURE_KEYS = [
  "enabled",
  "gap_detection",
  "generation",
  "llm_generation",
  "task_planner",
  "ticket_generator",
  "maintenance",
  "pack_composer",
  "audit_prompts",
  "section_classifier",
  "context_optimizer",
] as const;

export const CODE_METADATA_FEATURE_KEYS = [
  "enabled",
  "typescript_javascript",
  "python",
  "sql",
  "route_detection",
  "schema_detection",
  "stable_ids",
  "sidecar_metadata",
  "inline_metadata",
  "traceability_graph",
  "semantic_drift",
  "code_embedding_profile",
  "coverage_reports",
] as const;

export type AutomationFeatureKey = (typeof AUTOMATION_FEATURE_KEYS)[number];
export type CodeMetadataFeatureKey = (typeof CODE_METADATA_FEATURE_KEYS)[number];
export type FeatureGroupKey = "automation" | "code_metadata";
export type FeatureValues<T extends string> = Record<T, boolean>;

export interface FeatureDescriptor<T extends string = string> {
  key: T;
  label: string;
  description: string;
  stage: "available" | "planned";
}

export interface FeatureConfig {
  automation: FeatureValues<AutomationFeatureKey>;
  code_metadata: FeatureValues<CodeMetadataFeatureKey>;
  catalog: {
    automation: Array<FeatureDescriptor<AutomationFeatureKey>>;
    code_metadata: Array<FeatureDescriptor<CodeMetadataFeatureKey>>;
  };
}

const AUTOMATION_ENV: Record<AutomationFeatureKey, string> = {
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

const CODE_METADATA_ENV: Record<CodeMetadataFeatureKey, string> = {
  enabled: "SPECREG_CODE_METADATA_ENABLED",
  typescript_javascript: "SPECREG_CODE_METADATA_TYPESCRIPT_JAVASCRIPT",
  python: "SPECREG_CODE_METADATA_PYTHON",
  sql: "SPECREG_CODE_METADATA_SQL",
  route_detection: "SPECREG_CODE_METADATA_ROUTE_DETECTION",
  schema_detection: "SPECREG_CODE_METADATA_SCHEMA_DETECTION",
  stable_ids: "SPECREG_CODE_METADATA_STABLE_IDS",
  sidecar_metadata: "SPECREG_CODE_METADATA_SIDECAR",
  inline_metadata: "SPECREG_CODE_METADATA_INLINE",
  traceability_graph: "SPECREG_CODE_METADATA_TRACEABILITY_GRAPH",
  semantic_drift: "SPECREG_CODE_METADATA_SEMANTIC_DRIFT",
  code_embedding_profile: "SPECREG_CODE_METADATA_EMBEDDINGS",
  coverage_reports: "SPECREG_CODE_METADATA_COVERAGE_REPORTS",
};

const CODE_METADATA_DEFAULTS: Record<CodeMetadataFeatureKey, boolean> = {
  enabled: true,
  typescript_javascript: true,
  python: true,
  sql: true,
  route_detection: true,
  schema_detection: true,
  stable_ids: true,
  sidecar_metadata: true,
  inline_metadata: false,
  traceability_graph: true,
  semantic_drift: true,
  code_embedding_profile: true,
  coverage_reports: true,
};

const AUTOMATION_CATALOG: Array<FeatureDescriptor<AutomationFeatureKey>> = [
  { key: "enabled", label: "Automation master switch", description: "Controls every spec automation endpoint and workbench action.", stage: "available" },
  { key: "gap_detection", label: "Spec gap detection", description: "Find likely missing specs from a project tree and known spec list.", stage: "available" },
  { key: "generation", label: "Spec generation", description: "Create deterministic or LLM-assisted draft specifications.", stage: "available" },
  { key: "llm_generation", label: "LLM-backed variants", description: "Allows automation features to call configured LLM tiers when requested.", stage: "available" },
  { key: "task_planner", label: "Task planning", description: "Select relevant specs and acceptance criteria for implementation work.", stage: "available" },
  { key: "ticket_generator", label: "Ticket generation", description: "Turn SDD plans into concise implementation checklists.", stage: "available" },
  { key: "maintenance", label: "Maintenance suggestions", description: "Use feedback and ROI signals to recommend spec improvements.", stage: "available" },
  { key: "pack_composer", label: "Spec pack composer", description: "Build reusable starter spec packs for common project purposes.", stage: "available" },
  { key: "audit_prompts", label: "Audit prompts", description: "Generate and store reverse-conformance audit prompts for specs.", stage: "available" },
  { key: "section_classifier", label: "Section classifier", description: "Classify spec sections by role for context loading and review.", stage: "available" },
  { key: "context_optimizer", label: "Context optimizer", description: "Fit relevant spec sections into a target token budget.", stage: "available" },
];

const CODE_METADATA_CATALOG: Array<FeatureDescriptor<CodeMetadataFeatureKey>> = [
  { key: "enabled", label: "Code metadata master switch", description: "Controls AST/code metadata extraction and traceability features.", stage: "available" },
  { key: "typescript_javascript", label: "TypeScript and JavaScript", description: "Extract functions, classes, types, interfaces, methods, and routes.", stage: "available" },
  { key: "python", label: "Python", description: "Extract Python functions, classes, and decorated routes.", stage: "available" },
  { key: "sql", label: "SQL", description: "Extract table and index declarations from SQL files.", stage: "available" },
  { key: "route_detection", label: "Route detection", description: "Capture HTTP method and path metadata from common router APIs.", stage: "available" },
  { key: "schema_detection", label: "Schema detection", description: "Capture durable schema objects such as SQL tables and indexes.", stage: "available" },
  { key: "stable_ids", label: "Stable code IDs", description: "Generate durable entity IDs that survive body-only implementation changes.", stage: "available" },
  { key: "sidecar_metadata", label: "Sidecar metadata", description: "Write `.spec/code-map.json` instead of modifying source files.", stage: "available" },
  { key: "inline_metadata", label: "Inline metadata injection", description: "Optionally write trace IDs into source comments where a team permits it.", stage: "planned" },
  { key: "traceability_graph", label: "Traceability graph", description: "Link specs, spec sections, code entities, routes, and schemas.", stage: "available" },
  { key: "semantic_drift", label: "Semantic drift pipeline", description: "Compare code metadata against governed specs and report drift severity.", stage: "available" },
  { key: "code_embedding_profile", label: "Code embedding profile", description: "Configure embedding guidance for code entities separately from specs.", stage: "available" },
  { key: "coverage_reports", label: "Code-to-spec coverage reports", description: "Report mapped, unmapped, and stale implementation surfaces.", stage: "available" },
];

function envFlag(envName: string, fallback: boolean): boolean {
  const value = process.env[envName];
  if (value === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(value.toLowerCase());
}

function settingsMap(db: Db): Map<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'features.%'").all() as Array<{ key: string; value: string }>;
  return new Map(rows.map((row) => [row.key, row.value]));
}

function boolFromSetting(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "true" || value === "1";
}

function valuesFor<T extends string>(
  db: Db,
  group: FeatureGroupKey,
  keys: readonly T[],
  env: Record<T, string>,
  fallback: boolean | Record<T, boolean>
): FeatureValues<T> {
  const settings = settingsMap(db);
  return Object.fromEntries(
    keys.map((key) => {
      const setting = boolFromSetting(settings.get(`features.${group}.${key}`));
      const defaultValue = typeof fallback === "boolean" ? fallback : fallback[key];
      return [key, setting ?? envFlag(env[key], defaultValue)];
    })
  ) as FeatureValues<T>;
}

export function getAutomationFeatureFlags(db: Db): FeatureValues<AutomationFeatureKey> {
  const values = valuesFor(db, "automation", AUTOMATION_FEATURE_KEYS, AUTOMATION_ENV, true);
  if (!values.enabled) {
    return Object.fromEntries(AUTOMATION_FEATURE_KEYS.map((key) => [key, key === "enabled" ? false : false])) as FeatureValues<AutomationFeatureKey>;
  }
  return Object.fromEntries(
    AUTOMATION_FEATURE_KEYS.map((key) => [key, key === "enabled" ? true : values[key]])
  ) as FeatureValues<AutomationFeatureKey>;
}

export function getCodeMetadataFeatureFlags(db: Db): FeatureValues<CodeMetadataFeatureKey> {
  const values = valuesFor(db, "code_metadata", CODE_METADATA_FEATURE_KEYS, CODE_METADATA_ENV, CODE_METADATA_DEFAULTS);
  if (!values.enabled) {
    return Object.fromEntries(CODE_METADATA_FEATURE_KEYS.map((key) => [key, key === "enabled" ? false : false])) as FeatureValues<CodeMetadataFeatureKey>;
  }
  return Object.fromEntries(
    CODE_METADATA_FEATURE_KEYS.map((key) => [key, key === "enabled" ? true : values[key]])
  ) as FeatureValues<CodeMetadataFeatureKey>;
}

export function getFeatureConfig(db: Db): FeatureConfig {
  return {
    automation: getAutomationFeatureFlags(db),
    code_metadata: getCodeMetadataFeatureFlags(db),
    catalog: {
      automation: AUTOMATION_CATALOG,
      code_metadata: CODE_METADATA_CATALOG,
    },
  };
}

export function saveFeatureConfig(db: Db, input: Partial<Pick<FeatureConfig, "automation" | "code_metadata">>): FeatureConfig {
  const upsert = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  const saveGroup = <T extends string>(group: FeatureGroupKey, keys: readonly T[], values?: Partial<Record<T, boolean>>) => {
    if (!values) return;
    for (const key of keys) {
      const value = values[key];
      if (typeof value === "boolean") upsert.run(`features.${group}.${key}`, String(value));
    }
  };
  saveGroup("automation", AUTOMATION_FEATURE_KEYS, input.automation);
  saveGroup("code_metadata", CODE_METADATA_FEATURE_KEYS, input.code_metadata);
  return getFeatureConfig(db);
}
