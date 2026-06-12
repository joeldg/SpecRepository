import type {
  AgentFeedback,
  ChangeRequest,
  ProjectType,
  Spec,
  SpecSummary,
  SpecVersion,
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
};

const AUTHOR_KEY = "specregistry.author";

export function getAuthor(): string {
  return localStorage.getItem(AUTHOR_KEY) || "anonymous";
}

export function setAuthor(name: string): void {
  localStorage.setItem(AUTHOR_KEY, name);
}
