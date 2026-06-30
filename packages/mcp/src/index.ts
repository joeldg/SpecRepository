#!/usr/bin/env node
/**
 * SpecRegistry MCP server (stdio): lets MCP-capable agents (Claude Code, etc.)
 * read governed specs, search them, and file feedback without raw HTTP.
 *
 * Env: SPECREG_SERVER (default http://localhost:4000),
 *      SPECREG_PROJECT_TYPE (optional default project type for tools),
 *      SPECREG_REPO (optional repo/project identity for project-scoped specs),
 *      SPECREG_TOKEN (optional registry Bearer/API token).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER = process.env.SPECREG_SERVER ?? "http://localhost:4000";
const DEFAULT_TYPE = process.env.SPECREG_PROJECT_TYPE;
const DEFAULT_REPO = process.env.SPECREG_REPO;
const TOKEN = process.env.SPECREG_TOKEN;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (TOKEN && !headers.has("authorization")) headers.set("authorization", `Bearer ${TOKEN}`);
  const res = await fetch(`${SERVER}${path}`, { ...init, headers });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      detail = body.message ?? body.error ?? detail;
    } catch {
      // non-JSON error body
    }
    throw new Error(`SpecRegistry API error ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

const server = new McpServer({ name: "specregistry", version: "0.1.0" });

server.tool(
  "begin_task",
  "Call this BEFORE non-trivial implementation work. It registers the agent session, records the task/model/repo, returns the governed spec bundle for this project, and tells you whether preflight is ready or blocked. Use the returned session_id when calling finish_task.",
  {
    task: z.string().describe("The concrete task you are about to perform."),
    plan: z.string().optional().describe("Short implementation and verification plan mapped to the specs when known."),
    model: z.string().optional().describe("Model or agent runtime being used."),
    branch: z.string().optional().describe("Current git branch, if known."),
    specs_loaded: z.array(z.string()).optional().describe("Spec filenames or ids already loaded by the agent."),
    agent_identifier: z.string().optional().describe("Your model/agent name. Defaults to mcp-agent."),
    project_type: z.string().optional().describe("Project type name. Defaults to the repo's configured type."),
    repo: z.string().optional().describe("Repo/project identity. Defaults to SPECREG_REPO when set."),
    project_id: z.string().optional().describe("Explicit SpecRegistry project id."),
  },
  async ({ task, plan, model, branch, specs_loaded, agent_identifier, project_type, repo, project_id }) => {
    const type = project_type ?? DEFAULT_TYPE;
    if (!type) throw new Error("No project_type given and SPECREG_PROJECT_TYPE is not set");
    return text(
      await api("/api/v1/ai/agent-sessions/begin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task,
          plan,
          model,
          branch,
          specs_loaded: specs_loaded ?? [],
          agent_identifier,
          project_type: type,
          project_id,
          repo: project_id ? undefined : (repo ?? DEFAULT_REPO),
          mcp_server: SERVER,
        }),
      })
    );
  }
);

server.tool(
  "finish_task",
  "Call this instead of directly claiming done. It records completion evidence, runs the objective compliance gate, updates the agent session, and blocks completion until compliance passes.",
  {
    session_id: z.string().optional().describe("Session id returned by begin_task."),
    summary: z.string().optional().describe("What changed and why it satisfies the specs."),
    tests: z.array(z.string()).optional().describe("Verification commands or checks actually run."),
    changed_files: z.array(z.string()).optional().describe("Files changed by the task."),
    self_assessed_score: z.number().optional().describe("Your honest 0-100 estimate of how fully the work satisfies the specs."),
    trace: z.record(z.unknown()).optional().describe("Optional inline code-map trace; otherwise the registry uses the latest uploaded report."),
    project_type: z.string().optional().describe("Project type name. Required when session_id is omitted; defaults to configured type."),
    repo: z.string().optional().describe("Repo/project identity. Defaults to SPECREG_REPO when set."),
    project_id: z.string().optional().describe("Explicit SpecRegistry project id."),
  },
  async ({ session_id, summary, tests, changed_files, self_assessed_score, trace, project_type, repo, project_id }) => {
    const type = project_type ?? DEFAULT_TYPE;
    if (!session_id && !type) throw new Error("No session_id or project_type given and SPECREG_PROJECT_TYPE is not set");
    return text(
      await api("/api/v1/ai/agent-sessions/finish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id,
          summary,
          tests: tests ?? [],
          changed_files: changed_files ?? [],
          self_assessed_score,
          trace,
          project_type: type,
          project_id,
          repo: project_id ? undefined : (repo ?? DEFAULT_REPO),
        }),
      })
    );
  }
);

server.tool(
  "list_project_types",
  "List the project types (organization hierarchy) configured in the spec registry.",
  {},
  async () => {
    const types = await api<Array<Record<string, unknown>>>("/api/v1/project-types");
    return text(types.map(({ id, name, scope, industry, description }) => ({ id, name, scope, industry, description })));
  }
);

server.tool(
  "get_specs",
  "Fetch the latest governed specification documents (global + project type + project-specific overrides) with full markdown content. Always consult these before generating code for the project.",
  {
    project_type: z
      .string()
      .optional()
      .describe(`Project type name. Defaults to the repo's configured type${DEFAULT_TYPE ? ` (${DEFAULT_TYPE})` : ""}.`),
    repo: z.string().optional().describe("Repo/project identity for project-scoped specs. Defaults to SPECREG_REPO when set."),
    project_id: z.string().optional().describe("Explicit SpecRegistry project id."),
  },
  async ({ project_type, repo, project_id }) => {
    const type = project_type ?? DEFAULT_TYPE;
    if (!type) throw new Error("No project_type given and SPECREG_PROJECT_TYPE is not set");
    const params = new URLSearchParams();
    if (project_id) params.set("project_id", project_id);
    else if (repo ?? DEFAULT_REPO) params.set("repo", repo ?? DEFAULT_REPO!);
    return text(await api(`/api/v1/ai/specs/${encodeURIComponent(type)}${params.size ? `?${params}` : ""}`));
  }
);

server.tool(
  "search_specs",
  "Search governed specification documents and get back matching sections only. Supports fts, semantic, and hybrid modes. Includes project-scoped specs when repo/project_id is provided or SPECREG_REPO is set.",
  {
    query: z.string().describe("Search terms, e.g. 'TLS firewall rules'"),
    mode: z.enum(["fts", "semantic", "hybrid"]).optional().describe("Search mode. Defaults to hybrid when the registry has semantic embeddings indexed, otherwise fts."),
    project_type: z.string().optional().describe("Restrict to one project type (plus global and project-scoped specs)."),
    repo: z.string().optional().describe("Repo/project identity for project-scoped specs. Defaults to SPECREG_REPO when set."),
    project_id: z.string().optional().describe("Explicit SpecRegistry project id."),
  },
  async ({ query, mode, project_type, repo, project_id }) => {
    const params = new URLSearchParams({ q: query });
    params.set("mode", mode ?? "hybrid");
    const type = project_type ?? DEFAULT_TYPE;
    if (type) params.set("project_type", type);
    if (project_id) params.set("project_id", project_id);
    else if (repo ?? DEFAULT_REPO) params.set("repo", repo ?? DEFAULT_REPO!);
    return text(await api(`/api/v1/ai/search?${params}`));
  }
);

server.tool(
  "resolve_guidance",
  "Call this BEFORE writing code in a language, or working in a domain/topic (networking, auth, database, deployment, etc.), that the already-loaded specs do not clearly cover. Returns the governed specs that apply, the styleguides available to pull (with the exact `specreg styleguide add` command), and any coverage gaps. If something is uncovered, report it via report_spec_feedback and pull/generate the proper guidance — do not invent the standard.",
  {
    languages: z.array(z.string()).optional().describe("Programming language(s) about to be written, e.g. ['Go', 'Rust']."),
    topic: z.string().optional().describe("Domain/topic about to be worked on, e.g. 'networking', 'authentication', 'database schema'."),
    project_type: z.string().optional().describe("Project type name. Defaults to the repo's configured type."),
    repo: z.string().optional().describe("Repo/project identity for project-scoped specs. Defaults to SPECREG_REPO when set."),
    project_id: z.string().optional().describe("Explicit SpecRegistry project id."),
  },
  async ({ languages, topic, project_type, repo, project_id }) => {
    const type = project_type ?? DEFAULT_TYPE;
    return text(
      await api("/api/v1/ai/resolve-guidance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          languages: languages ?? [],
          topic,
          project_type: type,
          project_id,
          repo: project_id ? undefined : (repo ?? DEFAULT_REPO),
        }),
      })
    );
  }
);

server.tool(
  "check_compliance",
  "Call this BEFORE declaring a task complete. It returns an objective compliance verdict for this repo (traceability coverage, drift, and unmapped entities vs the project's policy) plus a directive. If it is NOT compliant, keep working on the outstanding items and call it again — do not report the task done until it returns compliant. Run `specreg code-map --report` first (or use `specreg comply`) so the verdict reflects your latest code. Pass your honest self_assessed_score; over-claims are flagged.",
  {
    self_assessed_score: z.number().optional().describe("Your honest 0-100 estimate of how fully the work satisfies the specs."),
    project_type: z.string().optional().describe("Project type name. Defaults to the repo's configured type."),
    repo: z.string().optional().describe("Repo/project identity. Defaults to SPECREG_REPO when set."),
    project_id: z.string().optional().describe("Explicit SpecRegistry project id."),
  },
  async ({ self_assessed_score, project_type, repo, project_id }) => {
    const type = project_type ?? DEFAULT_TYPE;
    return text(
      await api("/api/v1/ai/compliance-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          self_assessed_score,
          project_type: type,
          project_id,
          repo: project_id ? undefined : (repo ?? DEFAULT_REPO),
        }),
      })
    );
  }
);

server.tool(
  "report_guidance_gap",
  "Report missing language/domain guidance when resolve_guidance says a topic is uncovered and there is no existing spec_id to attach feedback to.",
  {
    topic: z.string().describe("The uncovered language/domain/topic, e.g. 'HTTP route API endpoint behavior'."),
    description: z.string().describe("What guidance was missing and what decision you needed."),
    languages: z.array(z.string()).optional().describe("Languages involved in the missing guidance."),
    context_code_snippet: z.string().optional().describe("Relevant code, task, or spec context."),
    agent_identifier: z.string().optional().describe("Your model/agent name. Defaults to mcp-agent."),
    project_type: z.string().optional().describe("Project type name. Defaults to the repo's configured type."),
    repo: z.string().optional().describe("Repo/project identity. Defaults to SPECREG_REPO when set."),
    project_id: z.string().optional().describe("Explicit SpecRegistry project id."),
  },
  async ({ topic, description, languages, context_code_snippet, agent_identifier, project_type, repo, project_id }) => {
    const type = project_type ?? DEFAULT_TYPE;
    const created = await api("/api/v1/ai/guidance-feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic,
        description,
        languages: languages ?? [],
        context_code_snippet,
        agent_identifier: agent_identifier ?? "mcp-agent",
        project_type: type,
        project_id,
        repo: project_id ? undefined : (repo ?? DEFAULT_REPO),
      }),
    });
    return text(created);
  }
);

server.tool(
  "report_spec_feedback",
  "Report an ambiguity, contradiction, or outdated guidance you found in a specification while executing a task. This flags the spec for human review — use it instead of guessing.",
  {
    spec_id: z.string().describe("The spec's id (from get_specs results)"),
    error_type: z.enum(["ambiguity", "contradiction", "outdated"]),
    description: z.string().describe("What is wrong, specifically, and what you needed instead"),
    context_code_snippet: z.string().optional().describe("Relevant code or spec excerpt"),
    agent_identifier: z.string().optional().describe("Your model/agent name"),
  },
  async (input) => {
    const created = await api("/api/v1/ai/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input,
        agent_identifier: input.agent_identifier ?? "mcp-agent",
      }),
    });
    return text(created);
  }
);

server.tool(
  "get_audit_prompt",
  "Fetch a reverse-conformance audit prompt for a governed spec. Use this before auditing whether code follows a spec's intent and requirements.",
  {
    spec_id: z.string().describe("Spec id from get_specs/search_specs results."),
    use_llm: z.boolean().optional().describe("Ask the registry server LLM to improve the prompt when enabled."),
  },
  async ({ spec_id, use_llm }) => {
    const suffix = use_llm ? "?use_llm=true" : "";
    return text(await api(`/api/v1/automation/audit-prompt/${encodeURIComponent(spec_id)}${suffix}`));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
