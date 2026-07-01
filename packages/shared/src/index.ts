/** Shared domain types for SpecRegistry (server, CLI, and web UI). */

export type Scope = "global" | "project_type" | "project";
export type SpecStatus = "draft" | "pending_review" | "published";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type VersionDelta = "major" | "minor" | "patch";
export type FeedbackErrorType = "ambiguity" | "contradiction" | "outdated" | "missing_guidance";
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
  /** Null for a "missing_guidance" report: a coverage gap with no spec to attach to. */
  spec_id: string | null;
  spec_version: string | null;
  agent_identifier: string;
  error_type: FeedbackErrorType;
  context_code_snippet: string | null;
  description: string;
  status: FeedbackStatus;
  /** Project type the gap was reported against; only set for spec_id-less reports. */
  project_type_id: string | null;
  /** JSON-encoded string[] of languages the gap applies to, if any. */
  languages: string | null;
  /** Domain/topic the gap applies to, if any. */
  topic: string | null;
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

// --- Style guide catalog (shared by the CLI installer and the server's guidance resolver) ---

export interface StyleGuideSource {
  title: string;
  url: string;
}

export interface StyleGuideEntry {
  id: string;
  title: string;
  filename: string;
  /** Languages this guide covers; matched case-insensitively against detected languages. */
  languages: string[];
  sources: StyleGuideSource[];
}

export const GOOGLE_STYLEGUIDE_BASE = "https://google.github.io/styleguide";

export const GOOGLE_STYLE_GUIDES: StyleGuideEntry[] = [
  {
    id: "docguide",
    title: "Google Documentation Guide",
    filename: "google-documentation-guide.md",
    languages: ["Markdown"],
    sources: [
      { title: "Overview", url: `${GOOGLE_STYLEGUIDE_BASE}/docguide/` },
      { title: "Markdown style guide", url: `${GOOGLE_STYLEGUIDE_BASE}/docguide/style.html` },
      { title: "Documentation best practices", url: `${GOOGLE_STYLEGUIDE_BASE}/docguide/best_practices.html` },
      { title: "README files", url: `${GOOGLE_STYLEGUIDE_BASE}/docguide/READMEs.html` },
      { title: "Philosophy", url: `${GOOGLE_STYLEGUIDE_BASE}/docguide/philosophy.html` },
    ],
  },
  {
    id: "typescript",
    title: "Google TypeScript Style Guide",
    filename: "google-typescript-style-guide.md",
    languages: ["TypeScript"],
    sources: [{ title: "TypeScript", url: `${GOOGLE_STYLEGUIDE_BASE}/tsguide.html` }],
  },
  {
    id: "javascript",
    title: "Google JavaScript Style Guide",
    filename: "google-javascript-style-guide.md",
    languages: ["JavaScript"],
    sources: [{ title: "JavaScript", url: `${GOOGLE_STYLEGUIDE_BASE}/jsguide.html` }],
  },
  {
    id: "html-css",
    title: "Google HTML/CSS Style Guide",
    filename: "google-html-css-style-guide.md",
    languages: ["HTML", "CSS"],
    sources: [{ title: "HTML/CSS", url: `${GOOGLE_STYLEGUIDE_BASE}/htmlcssguide.html` }],
  },
  {
    id: "json",
    title: "Google JSON Style Guide",
    filename: "google-json-style-guide.md",
    languages: ["JSON"],
    sources: [{ title: "JSON", url: `${GOOGLE_STYLEGUIDE_BASE}/jsoncstyleguide.xml` }],
  },
  {
    id: "python",
    title: "Google Python Style Guide",
    filename: "google-python-style-guide.md",
    languages: ["Python"],
    sources: [{ title: "Python", url: `${GOOGLE_STYLEGUIDE_BASE}/pyguide.html` }],
  },
  {
    id: "go",
    title: "Google Go Style Guide",
    filename: "google-go-style-guide.md",
    languages: ["Go"],
    sources: [{ title: "Go", url: `${GOOGLE_STYLEGUIDE_BASE}/go/` }],
  },
  {
    id: "java",
    title: "Google Java Style Guide",
    filename: "google-java-style-guide.md",
    languages: ["Java"],
    sources: [{ title: "Java", url: `${GOOGLE_STYLEGUIDE_BASE}/javaguide.html` }],
  },
  {
    id: "cpp",
    title: "Google C++ Style Guide",
    filename: "google-cpp-style-guide.md",
    languages: ["C++", "C"],
    sources: [{ title: "C++", url: `${GOOGLE_STYLEGUIDE_BASE}/cppguide.html` }],
  },
  {
    id: "csharp",
    title: "Google C# Style Guide",
    filename: "google-csharp-style-guide.md",
    languages: ["C#"],
    sources: [{ title: "C#", url: `${GOOGLE_STYLEGUIDE_BASE}/csharp-style.html` }],
  },
  {
    id: "shell",
    title: "Google Shell Style Guide",
    filename: "google-shell-style-guide.md",
    languages: ["Shell"],
    sources: [{ title: "Shell", url: `${GOOGLE_STYLEGUIDE_BASE}/shellguide.html` }],
  },
  {
    id: "swift",
    title: "Google Swift Style Guide",
    filename: "google-swift-style-guide.md",
    languages: ["Swift"],
    sources: [{ title: "Swift", url: `${GOOGLE_STYLEGUIDE_BASE}/swiftguide.html` }],
  },
];

/** Normalize a language label for matching (lowercase, strip punctuation/aliases). */
export function normalizeLanguage(language: string): string {
  const v = language.trim().toLowerCase();
  const aliases: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    golang: "go",
    "c++": "c++",
    cpp: "c++",
    "c#": "c#",
    csharp: "c#",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
  };
  return aliases[v] ?? v;
}

/** Style guides whose languages intersect the given (case-insensitive) languages. */
export function styleGuidesForLanguages(languages: string[]): StyleGuideEntry[] {
  const wanted = new Set(languages.map(normalizeLanguage));
  return GOOGLE_STYLE_GUIDES.filter((guide) =>
    guide.languages.some((lang) => wanted.has(normalizeLanguage(lang)))
  );
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
