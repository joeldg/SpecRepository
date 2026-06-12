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
export type SpecDetail = Spec & {
  versions: SpecVersion[];
  change_requests: ChangeRequest[];
  feedback: AgentFeedback[];
};
export type ReviewRow = ChangeRequest & {
  filename: string;
  current_version: string;
  project_type_id: string;
  project_type_name: string;
};
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
  excerpt: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
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
  review: (id: string) => request<ChangeRequest & { spec: Spec }>(`/api/v1/reviews/${id}`),
  approveReview: (id: string, reviewed_by: string) =>
    request<ChangeRequest>(`/api/v1/reviews/${id}/approve`, { method: "POST", body: JSON.stringify({ reviewed_by }) }),
  rejectReview: (id: string, reviewed_by: string) =>
    request<ChangeRequest>(`/api/v1/reviews/${id}/reject`, { method: "POST", body: JSON.stringify({ reviewed_by }) }),

  feedback: (status?: string) =>
    request<FeedbackRow[]>(`/api/v1/ai/feedback${status ? `?status=${status}` : ""}`),
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
  deleteTemplate: (id: string) => fetch(`/api/v1/templates/${id}`, { method: "DELETE" }),

  webhooks: () => request<Webhook[]>("/api/v1/webhooks"),
  createWebhook: (body: { url: string; events: string[]; format: string }) =>
    request<Webhook>("/api/v1/webhooks", { method: "POST", body: JSON.stringify(body) }),
  deleteWebhook: (id: string) => fetch(`/api/v1/webhooks/${id}`, { method: "DELETE" }),

  subscriptions: () => request<SubscriptionRow[]>("/api/v1/subscriptions"),
  createSubscription: (body: { project_type_id: string; repo: string; branch?: string; base_path?: string }) =>
    request<RepoSubscription>("/api/v1/subscriptions", { method: "POST", body: JSON.stringify(body) }),
  deleteSubscription: (id: string) => fetch(`/api/v1/subscriptions/${id}`, { method: "DELETE" }),
  syncJobs: () => request<SyncJobRow[]>("/api/v1/sync-jobs"),
  runSyncJobs: () =>
    request<{ processed: number }>("/api/v1/sync-jobs/run", { method: "POST", body: JSON.stringify({}) }),

  analytics: () => request<AnalyticsSummary>("/api/v1/analytics/summary"),
};

const AUTHOR_KEY = "specregistry.author";

export function getAuthor(): string {
  return localStorage.getItem(AUTHOR_KEY) || "anonymous";
}

export function setAuthor(name: string): void {
  localStorage.setItem(AUTHOR_KEY, name);
}
