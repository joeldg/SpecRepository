import type { ProjectType } from "@specregistry/shared";

export function mcpConfig(serverUrl: string, projectType?: ProjectType, repo = "owner/repo") {
  return {
    mcpServers: {
      specregistry: {
        command: "specreg",
        args: ["mcp"],
        env: {
          SPECREG_SERVER: serverUrl,
          ...(projectType ? { SPECREG_PROJECT_TYPE: projectType.name } : {}),
          SPECREG_REPO: repo,
        },
      },
    },
  };
}

export function mcpSkillMarkdown(serverUrl: string, projectType?: ProjectType, repo = "owner/repo"): string {
  return `# SpecRegistry MCP Skill

Use this skill when working in a repository governed by SpecRegistry.

## Configure MCP

Add this server to the repository's MCP configuration. The generated command uses
\`specreg mcp\` so the dashboard-downloaded CLI also supplies the MCP server; local
development may still link \`specreg-mcp\`, but initialized repos should prefer this form:

\`\`\`json
${JSON.stringify(mcpConfig(serverUrl, projectType, repo), null, 2)}
\`\`\`

If the project type is not preconfigured, call \`list_project_types\` first and choose the best match.
If the registry requires authentication, add \`SPECREG_TOKEN\` to the MCP server \`env\` block. Use a
login token or long-lived API key with the minimum role needed for the workflow.
When working in a concrete repository, set \`SPECREG_REPO\` to the repo identity reported by \`specreg init\`
so project-scoped specs and overrides load with global and project-type specs.

## Required Workflow

Do not edit code, configuration, tests, or generated artifacts until the pre-implementation gate is complete:

1. Run \`specreg check\` and stop on drift, missing specs, or tampered governed files.
2. Start the \`specregistry\` MCP server from \`.mcp.json\` and call \`begin_task\` for the project type and repo.
3. Call \`get_specs\` for the project type and repo, using the \`begin_task\` response as the preflight session record.
4. Load relevant governed procedures from \`.spec/skills/*/SKILL.md\` when present before performing that workflow.
5. Use \`search_specs\` with \`mode: "hybrid"\`, the project type, and repo when you need focused guidance from a large spec set.
6. If specs are ambiguous, contradictory, outdated, or missing intent, call \`report_spec_feedback\` with the affected \`spec_id\`, issue type, description, and relevant code or spec context.
7. Do not silently ignore a governed requirement. Either follow it or report feedback.
8. If MCP is unavailable, use only the documented agent API fallback, record that MCP was unavailable, and do not browse/probe registry routes.
9. Before reporting completion, call \`finish_task\` with the \`session_id\` from \`begin_task\`; keep working until the objective verdict passes. Use \`check_compliance\` or \`specreg comply\` for direct compliance checks and CI gates.

## MCP Tools

- \`begin_task\`: register an agent session, preflight the task, and return the governed spec bundle to load.
- \`finish_task\`: record completion evidence, run objective compliance, and block completion until it passes.
- \`list_project_types\`: list configured project types.
- \`get_specs\`: fetch full markdown specs for a project type, including global specs and repo-specific overrides.
- \`search_specs\`: search matching spec sections with FTS, semantic, or hybrid retrieval, including project-scoped specs when a repo is configured.
- \`resolve_guidance\`: check whether a language/domain is covered before inventing a local standard.
- \`check_compliance\`: record and evaluate the objective compliance loop for the repo.
- \`report_spec_feedback\`: file ambiguity, contradiction, or outdated-guidance feedback for review.
- \`get_audit_prompt\`: fetch reverse-conformance prompts for checking implementation against spec intent.
`;
}
