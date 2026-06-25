/** Shared domain types for SpecRegistry (server, CLI, and web UI). */

export type Scope = "global" | "project_type" | "project";
export type SpecStatus = "draft" | "pending_review" | "published";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type VersionDelta = "major" | "minor" | "patch";
export type FeedbackErrorType = "ambiguity" | "contradiction" | "outdated";
export type FeedbackStatus = "open" | "acknowledged" | "resolved";

export interface ProjectType {
  id: string;
  name: string;
  scope: Scope;
  industry: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface Spec {
  id: string;
  /** Global specs belong to the seeded scope="global" project type */
  project_type_id: string;
  project_id: string | null;
  filename: string;
  current_version: string;
  status: SpecStatus;
  content: string;
  updated_by: string;
  audit_prompt?: string | null;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** Spec listing entry without the (potentially large) markdown body. */
export type SpecSummary = Omit<Spec, "content"> & {
  project_type_name: string;
  project_type_scope: Scope;
  project_name: string | null;
  effective_scope: Scope;
  open_feedback_count: number;
  pending_review_count: number;
};

export interface SpecVersion {
  id: string;
  spec_id: string;
  version: string;
  content: string;
  published_by: string;
  published_at: string;
}

export interface ChangeRequest {
  id: string;
  spec_id: string;
  proposed_by: string;
  version_delta: VersionDelta;
  /** Unified diff of current published content vs. proposed content */
  diff: string;
  proposed_content: string;
  summary: string | null;
  status: ReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  /** Version published as a result of approval, if any */
  resulting_version: string | null;
  /** JSON compatibility analysis captured at submission time */
  compatibility?: string | null;
  /** JSON lint report captured at submission time */
  lint?: string | null;
  /** JSON contradiction report captured at submission time */
  contradictions?: string | null;
  /** JSON risk score captured at submission time */
  risk?: string | null;
  created_at: string;
}

export interface AgentFeedback {
  id: string;
  spec_id: string;
  spec_version: string;
  agent_identifier: string;
  error_type: FeedbackErrorType;
  context_code_snippet: string | null;
  description: string;
  status: FeedbackStatus;
  created_at: string;
}

export interface StubPrompt {
  id: string;
  /** Target file the prompt generates, e.g. DESIGN.md */
  target_filename: string;
  /** Template with [CONTEXT] / [TREE] / [LANGUAGES] / [PROJECT_TYPE] placeholders */
  template: string;
  description: string | null;
}

export interface StubPromptRequest {
  project_type: string;
  detected_languages: string[];
}

export interface StubPromptResponse {
  project_type: string;
  prompts: Array<{
    target_filename: string;
    prompt: string;
  }>;
}

export interface SpecTemplate {
  id: string;
  filename: string;
  /** JSON array of required heading texts */
  required_sections: string;
  content_template: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface Webhook {
  id: string;
  url: string;
  /** JSON array of subscribed event names; empty = all events */
  events: string;
  format: "json" | "slack" | "gchat";
  active: number;
  created_at: string;
}

export interface RepoSubscription {
  id: string;
  project_type_id: string;
  /** "owner/name" */
  repo: string;
  branch: string;
  base_path: string;
  created_at: string;
}

export interface SyncJob {
  id: string;
  subscription_id: string;
  spec_id: string;
  version: string;
  status: "pending" | "done" | "error";
  detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncCheckRequest {
  project_type: string;
  specs: Array<{ filename: string; version: string }>;
}

export interface SyncCheckResponse {
  project_type: string;
  up_to_date: string[];
  outdated: Array<{
    filename: string;
    local_version: string;
    latest_version: string;
    severity: VersionDelta;
    within_pin: boolean;
  }>;
  missing_locally: Array<{ filename: string; latest_version: string }>;
  not_on_server: string[];
  drift: boolean;
}

/** Strip a prerelease suffix: "1.2.0-beta.1" -> "1.2.0". */
export function stableOf(version: string): string {
  return version.replace(/-.*$/, "");
}

/** Drift severity between two stable semver strings. */
export function driftSeverity(local: string, latest: string): VersionDelta {
  const [lMaj, lMin] = stableOf(local).split(".").map(Number);
  const [sMaj, sMin] = stableOf(latest).split(".").map(Number);
  if (lMaj !== sMaj) return "major";
  if (lMin !== sMin) return "minor";
  return "patch";
}

/** Caret-range check: "^1.2.0" admits >=1.2.0 <2.0.0 (for major 0: same minor). */
export function satisfiesCaret(version: string, pin: string): boolean {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(pin.trim());
  if (!match) return true; // unsupported pin syntax: don't block
  const [pMaj, pMin, pPat] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = /^(\d+)\.(\d+)\.(\d+)/.exec(stableOf(version));
  if (!parsed) return false;
  const [vMaj, vMin, vPat] = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])];
  if (vMaj !== pMaj) return false;
  if (pMaj === 0 && vMin !== pMin) return false;
  if (vMin > pMin) return true;
  if (vMin < pMin) return false;
  return vPat >= pPat;
}

/** Bump a semantic version string by the given delta. */
export function bumpVersion(version: string, delta: VersionDelta): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Invalid semantic version: ${version}`);
  }
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  switch (delta) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}
