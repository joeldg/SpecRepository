#!/usr/bin/env node
/**
 * SpecRegistry MCP server (stdio): lets MCP-capable agents (Claude Code, etc.)
 * read governed specs, search them, and file feedback without raw HTTP.
 *
 * Env: SPECREG_SERVER (default http://localhost:4000),
 *      SPECREG_PROJECT_TYPE (optional default project type for tools).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER = process.env.SPECREG_SERVER ?? "http://localhost:4000";
const DEFAULT_TYPE = process.env.SPECREG_PROJECT_TYPE;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER}${path}`, init);
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
  "Fetch the latest governed specification documents (global + project type) with full markdown content. Always consult these before generating code for the project.",
  {
    project_type: z
      .string()
      .optional()
      .describe(`Project type name. Defaults to the repo's configured type${DEFAULT_TYPE ? ` (${DEFAULT_TYPE})` : ""}.`),
  },
  async ({ project_type }) => {
    const type = project_type ?? DEFAULT_TYPE;
    if (!type) throw new Error("No project_type given and SPECREG_PROJECT_TYPE is not set");
    return text(await api(`/api/v1/ai/specs/${encodeURIComponent(type)}`));
  }
);

server.tool(
  "search_specs",
  "Search the registry's specification documents by keyword and get back the matching sections only. Use this to find relevant guidance without loading whole documents.",
  {
    query: z.string().describe("Search terms, e.g. 'TLS firewall rules'"),
    project_type: z.string().optional().describe("Restrict to one project type (plus global specs)."),
  },
  async ({ query, project_type }) => {
    const params = new URLSearchParams({ q: query });
    const type = project_type ?? DEFAULT_TYPE;
    if (type) params.set("project_type", type);
    return text(await api(`/api/v1/ai/search?${params}`));
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

const transport = new StdioServerTransport();
await server.connect(transport);
