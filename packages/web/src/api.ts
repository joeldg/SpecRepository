import type {
  AgentFeedback,
  ChangeRequest,
  ProjectType,
  RepoSubscription,
  Spec,
  SpecSummary,
  SpecTemplate,
  SpecVersion,
  SyncJob,
  Webhook,
} from "@specregistry/shared";

export type ProjectTypeWithCount = ProjectType & { spec_count: number };
export interface EfficacyRun {
  id: string;
  spec_id: string;
  task_prompt: string;
  score_with: number;
  score_without: number;
  improved: number;
  rationale: string;
  model: string;
  created_at: string;
}
export type SpecDetail = Spec & {
  versions: Array<SpecVersion & { channel?: string }>;
  change_requests: ChangeRequest[];
  feedback: AgentFeedback[];
  efficacy_runs: EfficacyRun[];
};
export type ReviewRow = ChangeRequest & {
  filename: string;
  current_version: string;
  project_type_id: string;
  project_type_name: string;
};
export type ReviewDetail = ChangeRequest & {
  spec: Spec;
  approvals: Array<{ reviewer: string; created_at: string }>;
  approval_count: number;
  required_approvals: number;
  approval_policy: null | {
    id: string;
    filename_glob: string;
    min_approvals: number;
    required_reviewers: string[];
  };
};
export interface ReviewSlaSummary {
  warn_hours: number;
  breach_hours: number;
  pending_count: number;
  warning_count: number;
  breached_count: number;
  oldest_age_hours: number;
  queue: Array<
    Pick<ReviewRow, "id" | "spec_id" | "filename" | "project_type_name" | "proposed_by" | "version_delta" | "summary" | "created_at"> & {
      current_version: string;
      approval_count: number;
      required_approvals: number;
      remaining_approvals: number;
      age_hours: number;
      sla_status: "ok" | "warning" | "breached";
    }
  >;
}
export type FeedbackRow = AgentFeedback & {
  filename: string;
  current_version: string;
  project_type_name: string;
};
export type SubscriptionRow = RepoSubscription & { project_type_name: string };
export type SyncJobRow = SyncJob & { repo: string; branch: string; filename: string };
export interface AnalyticsSummary {
  window_days: number;
  events: Record<string, number>;
  top_project_types: Array<{ name: string; n: number }>;
  stale_specs: Array<{
    id: string;
    filename: string;
    current_version: string;
    updated_at: string;
    project_type_name: string;
  }>;
}
export interface SearchHit {
  spec_id: string;
  filename: string;
  project_type_name: string;
  current_version: string;
  section: string;
  section_anchor: string;
  permalink: string;
  excerpt: string;
}
export interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  role: "admin" | "reviewer" | "author" | "agent";
  source: "local" | "ldap";
  created_at: string;
}
export interface ApiKeyRow {
  id: string;
  user_id: string;
  username: string;
  role: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
}
export interface LdapConfig {
  enabled: boolean;
  url: string;
  bind_dn_template: string;
  bind_user: string;
  search_base: string;
  search_filter: string;
  admin_group: string;
  reviewer_group: string;
  default_role: "admin" | "reviewer" | "author" | "agent";
  has_bind_password: boolean;
}
export interface LlmConfig {
  provider: "anthropic" | "openai" | "gemini" | "openai_compatible";
  model: string;
  base_url: string;
  max_tokens: number;
  has_api_key: boolean;
}
export interface McpGuide {
  filename: string;
  project_type: string | null;
  mcp_config: Record<string, unknown>;
  content: string;
}
export interface ApprovalPolicyRow {
  id: string;
  project_type_id: string | null;
  project_type_name?: string | null;
  filename_glob: string;
  min_approvals: number;
  required_reviewers: string;
  created_at: string;
  updated_at: string;
}
export interface FeedbackCluster {
  key: string;
  spec_id: string;
  filename: string;
  project_type_name: string;
  error_type: string;
  count: number;
  status_counts: Record<string, number>;
  latest_at: string;
  sample_description: string;
  feedback_ids: string[];
}
export interface AuditLogRow {
  id: string;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  summary: string;
  detail: string | null;
  created_at: string;
}

const TOKEN_KEY = "specregistry.token";
const USERNAME_KEY = "specregistry.username";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getLoginUsername(): string | null {
  return localStorage.getItem(USERNAME_KEY);
}

export function setSession(token: string, username: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USERNAME_KEY, username);
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USERNAME_KEY);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      message = body.message ?? body.error ?? message;
    } catch {
      // keep default message
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

async function requestVoid(url: string, init?: RequestInit): Promise<void> {
  const token = getToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      message = body.message ?? body.error ?? message;
    } catch {
      // keep default message
    }
    throw new Error(message);
  }
}

export const api = {
  projectTypes: () => request<ProjectTypeWithCount[]>("/api/v1/project-types"),
  createProjectType: (body: { name: string; industry?: string; description?: string }) =>
    request<ProjectType>("/api/v1/project-types", { method: "POST", body: JSON.stringify(body) }),

  specs: () => request<SpecSummary[]>("/api/v1/specs"),
  spec: (id: string) => request<SpecDetail>(`/api/v1/specs/${id}`),
  createSpec: (body: { project_type_id: string; filename: string; content: string; updated_by: string }) =>
    request<Spec>("/api/v1/specs", { method: "POST", body: JSON.stringify(body) }),
  updateDraft: (id: string, body: { content: string; updated_by: string }) =>
    request<Spec>(`/api/v1/specs/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  publishDraft: (id: string, published_by: string) =>
    request<Spec>(`/api/v1/specs/${id}/publish`, { method: "POST", body: JSON.stringify({ published_by }) }),
  submitReview: (body: {
    spec_id: string;
    proposed_content: string;
    version_delta: string;
    proposed_by: string;
    summary?: string;
  }) => request<ChangeRequest>("/api/v1/specs/review", { method: "POST", body: JSON.stringify(body) }),

  reviews: (status?: string) =>
    request<ReviewRow[]>(`/api/v1/reviews${status ? `?status=${status}` : ""}`),
  reviewSla: () => request<ReviewSlaSummary>("/api/v1/reviews/sla"),
  review: (id: string) => request<ReviewDetail>(`/api/v1/reviews/${id}`),
  approveReview: (id: string, reviewed_by: string, channel?: "stable" | "beta") =>
    request<ChangeRequest>(`/api/v1/reviews/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ reviewed_by, ...(channel === "beta" ? { channel } : {}) }),
    }),
  rejectReview: (id: string, reviewed_by: string) =>
    request<ChangeRequest>(`/api/v1/reviews/${id}/reject`, { method: "POST", body: JSON.stringify({ reviewed_by }) }),

  feedback: (status?: string) =>
    request<FeedbackRow[]>(`/api/v1/ai/feedback${status ? `?status=${status}` : ""}`),
  feedbackClusters: (status?: string) =>
    request<FeedbackCluster[]>(`/api/v1/ai/feedback/clusters${status ? `?status=${status}` : ""}`),
  setFeedbackStatus: (id: string, status: string) =>
    request<AgentFeedback>(`/api/v1/ai/feedback/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }),
  draftFix: (feedbackId: string) =>
    request<ChangeRequest>(`/api/v1/ai/feedback/${feedbackId}/draft-fix`, { method: "POST", body: JSON.stringify({}) }),

  search: (q: string, projectType?: string) =>
    request<{ query: string; results: SearchHit[] }>(
      `/api/v1/ai/search?q=${encodeURIComponent(q)}${projectType ? `&project_type=${encodeURIComponent(projectType)}` : ""}`
    ),

  templates: () => request<SpecTemplate[]>("/api/v1/templates"),
  createTemplate: (body: {
    filename: string;
    required_sections: string[];
    content_template?: string;
    description?: string;
  }) => request<SpecTemplate>("/api/v1/templates", { method: "POST", body: JSON.stringify(body) }),
  updateTemplate: (id: string, body: Partial<{ required_sections: string[]; content_template: string; description: string }>) =>
    request<SpecTemplate>(`/api/v1/templates/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteTemplate: (id: string) => requestVoid(`/api/v1/templates/${id}`, { method: "DELETE" }),

  webhooks: () => request<Webhook[]>("/api/v1/webhooks"),
  createWebhook: (body: { url: string; events: string[]; format: string }) =>
    request<Webhook>("/api/v1/webhooks", { method: "POST", body: JSON.stringify(body) }),
  deleteWebhook: (id: string) => requestVoid(`/api/v1/webhooks/${id}`, { method: "DELETE" }),

  subscriptions: () => request<SubscriptionRow[]>("/api/v1/subscriptions"),
  createSubscription: (body: { project_type_id: string; repo: string; branch?: string; base_path?: string }) =>
    request<RepoSubscription>("/api/v1/subscriptions", { method: "POST", body: JSON.stringify(body) }),
  deleteSubscription: (id: string) => requestVoid(`/api/v1/subscriptions/${id}`, { method: "DELETE" }),
  syncJobs: () => request<SyncJobRow[]>("/api/v1/sync-jobs"),
  runSyncJobs: () =>
    request<{ processed: number }>("/api/v1/sync-jobs/run", { method: "POST", body: JSON.stringify({}) }),

  analytics: () => request<AnalyticsSummary>("/api/v1/analytics/summary"),
  auditLog: (limit = 100) => request<AuditLogRow[]>(`/api/v1/audit-log?limit=${limit}`),

  login: (username: string, password: string) =>
    request<{ token: string; user: { username: string; role: string } }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  users: () => request<UserRow[]>("/api/v1/auth/users"),
  createUser: (body: { username: string; role: string; password?: string; display_name?: string }) =>
    request<UserRow>("/api/v1/auth/users", { method: "POST", body: JSON.stringify(body) }),
  apiKeys: () => request<ApiKeyRow[]>("/api/v1/auth/api-keys"),
  createApiKey: (body: { username: string; name?: string }) =>
    request<{ token: string; username: string; role: string }>("/api/v1/auth/api-keys", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteApiKey: (id: string) => requestVoid(`/api/v1/auth/api-keys/${id}`, { method: "DELETE" }),
  ldapConfig: () => request<LdapConfig>("/api/v1/ldap/config"),
  updateLdapConfig: (body: Partial<Omit<LdapConfig, "enabled" | "has_bind_password">> & {
    bind_password?: string;
    clear_bind_password?: boolean;
  }) => request<LdapConfig>("/api/v1/ldap/config", { method: "PUT", body: JSON.stringify(body) }),
  testLdap: (username: string, password: string) =>
    request<{ ok: boolean; username: string; dn: string; display_name: string | null; groups: string[]; role: string }>(
      "/api/v1/ldap/test",
      { method: "POST", body: JSON.stringify({ username, password }) }
    ),
  previewLdapRole: (groups: string[]) =>
    request<{ role: string; groups: string[] }>("/api/v1/ldap/role-preview", {
      method: "POST",
      body: JSON.stringify({ groups }),
    }),
  llmConfig: () => request<LlmConfig>("/api/v1/llm/config"),
  updateLlmConfig: (body: Partial<Omit<LlmConfig, "has_api_key">> & { api_key?: string; clear_api_key?: boolean }) =>
    request<LlmConfig>("/api/v1/llm/config", { method: "PUT", body: JSON.stringify(body) }),
  testLlm: (prompt?: string, max_tokens?: number) =>
    request<{ ok: boolean; provider: string; model: string; text: string; max_tokens: number }>("/api/v1/llm/test", {
      method: "POST",
      body: JSON.stringify({ prompt, max_tokens }),
    }),
  llmModels: () => request<{ provider: string; models: string[] }>("/api/v1/llm/models"),
  mcpGuide: (projectType?: string) =>
    request<McpGuide>(`/api/v1/ai/mcp-guide${projectType ? `/${encodeURIComponent(projectType)}` : ""}`),
  approvalPolicies: () => request<ApprovalPolicyRow[]>("/api/v1/approval-policies"),
  createApprovalPolicy: (body: {
    project_type_id?: string | null;
    filename_glob: string;
    min_approvals: number;
    required_reviewers: string[];
  }) => request<ApprovalPolicyRow>("/api/v1/approval-policies", { method: "POST", body: JSON.stringify(body) }),
  deleteApprovalPolicy: (id: string) => requestVoid(`/api/v1/approval-policies/${id}`, { method: "DELETE" }),
  promote: (specId: string, version: string, promoted_by: string) =>
    request<Spec>(`/api/v1/specs/${specId}/promote`, {
      method: "POST",
      body: JSON.stringify({ version, promoted_by }),
    }),
  runEfficacy: (spec_id: string, task_prompt: string) =>
    request<EfficacyRun>("/api/v1/ai/efficacy", { method: "POST", body: JSON.stringify({ spec_id, task_prompt }) }),
  updateProjectType: (id: string, body: Record<string, unknown>) =>
    request<ProjectType>(`/api/v1/project-types/${id}`, { method: "PUT", body: JSON.stringify(body) }),
};

const AUTHOR_KEY = "specregistry.author";

export function getAuthor(): string {
  // A signed-in identity wins over the free-text "acting as" name.
  return getLoginUsername() || localStorage.getItem(AUTHOR_KEY) || "anonymous";
}

export function setAuthor(name: string): void {
  localStorage.setItem(AUTHOR_KEY, name);
}
