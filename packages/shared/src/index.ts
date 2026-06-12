/** Shared domain types for SpecRegistry (server, CLI, and web UI). */

export type Scope = "global" | "project_type";
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
  filename: string;
  current_version: string;
  status: SpecStatus;
  content: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

/** Spec listing entry without the (potentially large) markdown body. */
export type SpecSummary = Omit<Spec, "content"> & {
  project_type_name: string;
  project_type_scope: Scope;
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
