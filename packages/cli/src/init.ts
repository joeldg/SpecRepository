import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";
import type { Spec } from "@specregistry/shared";
import { fetchJson, registryToken, selectProjectType, withRegistryAuth } from "./registry.js";
import { repoIdentity, reportManifest, type Manifest } from "./repo.js";
import { enrollAgent } from "./credentials.js";
import { installGoogleStyleGuides, type InstalledStyleGuide } from "./styleguides.js";
import { renderProjectProfile, runProjectSetupWizard, type ProjectProfile } from "./projectWizard.js";
import { installAgentSkills, listAgentSkills, resolveAgentSkills, type AgentSkill } from "./skills.js";

export interface InitOptions {
  server: string;
  token?: string;
  type?: string;
  dir: string;
  force?: boolean;
  styleguides?: string;
  styleguideDir: string;
  skills?: string;
  skillDir: string;
}

export async function runInit(opts: InitOptions): Promise<void> {
  const setup = opts.type
    ? {
        projectType: await selectProjectType(opts.server, opts.type, opts.token),
        profile: undefined,
        skills: resolveAgentSkills(await listAgentSkills(opts.server, opts.token), opts.skills),
      }
    : await runProjectSetupWizard(opts.server, opts.token, opts.skills);
  const { projectType, profile, skills } = setup;
  if (profile) assertProjectProfileTargetsAvailable(profile, opts.force === true);
  console.log(`\nFetching latest approved specs for "${projectType.name}"...`);

  const identity = repoIdentity();

  // Give this repo its own agent identity so it authenticates as itself (never admin)
  // for submissions, telemetry, and project-scoped specs. Falls back to anonymous if
  // enrollment is disabled on the server.
  const token = opts.token ?? (await enrollAgent(opts.server, identity.repo, projectType.name));
  if (token && !opts.token) {
    console.log(`Enrolled agent identity for ${identity.repo}; token stored in .spec/credentials.json (gitignored).`);
  }

  const url = `${opts.server}/api/v1/specs/${encodeURIComponent(projectType.name)}/download?repo=${encodeURIComponent(identity.repo)}`;
  const res = await fetch(url, withRegistryAuth(undefined, token));
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));

  const outDir = path.resolve(process.cwd(), opts.dir);
  fs.mkdirSync(outDir, { recursive: true });
  const manifestEntry = zip.getEntry(".specregistry.json");
  if (!manifestEntry) throw new Error("Downloaded bundle did not include .specregistry.json");
  const nextManifest = JSON.parse(manifestEntry.getData().toString("utf8")) as Manifest;
  validateSafeExtraction(zip, outDir, opts.force === true);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const target = path.resolve(outDir, entry.entryName);
    if (!target.startsWith(outDir + path.sep) && target !== outDir) {
      throw new Error(`Refusing to extract suspicious bundle path: ${entry.entryName}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }

  const entries = zip.getEntries().filter((e) => e.entryName !== ".specregistry.json");
  console.log(`\nWrote ${entries.length} spec file(s) to ${path.relative(process.cwd(), outDir) || "."}/:`);
  for (const entry of entries) {
    console.log(`  - ${entry.entryName}`);
  }
  console.log(`\nManifest saved as ${opts.dir}/.specregistry.json (records versions for future syncs).`);

  let styleGuides: InstalledStyleGuide[] = [];
  try {
    styleGuides = await installGoogleStyleGuides({
      selection: opts.styleguides,
      dir: opts.styleguideDir,
      force: opts.force,
      suggestedLanguages: profile?.languages,
    });
  } catch (err) {
    console.log(`Could not install Google style guides: ${err instanceof Error ? err.message : String(err)}`);
  }
  installAgentSkills(skills, opts.skillDir, opts.force === true);

  writeMcpConfig(opts.server, projectType.name, identity.repo, registryToken(token));
  writeRegistryGuide(opts.server, projectType.name, identity.repo, opts.dir, registryToken(token), styleGuides, opts.styleguideDir, skills, opts.skillDir);
  writeAgentsBootstrap(opts.server, projectType.name, identity.repo, opts.dir, opts.skillDir);
  let projectId: string | undefined;
  try {
    const reported = await reportManifest(opts.server, token, nextManifest, opts.dir, "init");
    projectId = reported.project_id;
    console.log("Reported local spec manifest to the registry.");
    console.log(`Project scope: ${reported.project_id}`);
  } catch (err) {
    console.log(`Could not report manifest usage: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (profile) {
    writeProjectProfile(profile, projectType.name);
    if (projectId) {
      await submitProjectProfile(opts.server, token, projectType.id, projectId, profile, projectType.name);
    } else {
      console.log("The local project profile draft was preserved but could not be submitted without a reported project scope.");
    }
  }
}

function assertProjectProfileTargetsAvailable(profile: ProjectProfile, force: boolean): void {
  if (!profile.project_name.trim()) throw new Error("Project profile requires a project name.");
  if (force) return;
  const targets = [
    path.resolve(process.cwd(), ".spec/project-profile.json"),
    path.resolve(process.cwd(), ".spec/drafts/PROJECT_PROFILE.md"),
  ];
  const existing = targets.filter((target) => fs.existsSync(target));
  if (existing.length > 0) {
    throw new Error(
      `Refusing to overwrite existing project profile files: ${existing.map((target) => path.relative(process.cwd(), target)).join(", ")}. ` +
        "Re-run with --force to replace them."
    );
  }
}

function writeProjectProfile(profile: ProjectProfile, projectType: string): void {
  const profilePath = path.resolve(process.cwd(), ".spec/project-profile.json");
  const draftPath = path.resolve(process.cwd(), ".spec/drafts/PROJECT_PROFILE.md");
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.mkdirSync(path.dirname(draftPath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify({ ...profile, project_type: projectType }, null, 2) + "\n", "utf8");
  fs.writeFileSync(draftPath, renderProjectProfile(profile, projectType), "utf8");
  console.log("Wrote .spec/project-profile.json and .spec/drafts/PROJECT_PROFILE.md.");
}

async function submitProjectProfile(
  server: string,
  token: string | undefined,
  projectTypeId: string,
  projectId: string,
  profile: ProjectProfile,
  projectType: string
): Promise<void> {
  try {
    const created = await fetchJson<Spec>(`${server}/api/v1/specs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_type_id: projectTypeId,
        project_id: projectId,
        filename: "PROJECT_PROFILE.md",
        content: renderProjectProfile(profile, projectType),
        updated_by: process.env.USER || "specreg-init",
      }),
    }, token);
    console.log(`Submitted PROJECT_PROFILE.md as project-scoped draft ${created.id}.`);
    console.log("Review and publish it in SpecRegistry before treating the profile as governed guidance.");
  } catch (err) {
    console.log(`Could not submit PROJECT_PROFILE.md automatically: ${err instanceof Error ? err.message : String(err)}`);
    console.log("The local draft is preserved; run specreg submit-drafts to send it through the registry workflow.");
  }
}

function validateSafeExtraction(zip: AdmZip, outDir: string, force: boolean): void {
  if (force) return;
  const existingManifestPath = path.join(outDir, ".specregistry.json");
  const previous = fs.existsSync(existingManifestPath)
    ? (JSON.parse(fs.readFileSync(existingManifestPath, "utf8")) as Manifest)
    : undefined;
  const previousByName = new Map(previous?.specs.map((spec) => [spec.filename, spec.sha256]) ?? []);
  const conflicts: string[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || entry.entryName === ".specregistry.json") continue;
    const target = path.resolve(outDir, entry.entryName);
    if (!fs.existsSync(target)) continue;
    const currentHash = sha256(fs.readFileSync(target));
    const previousHash = previousByName.get(entry.entryName);
    if (!previousHash || previousHash !== currentHash) conflicts.push(entry.entryName);
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to overwrite locally modified or unmanaged governed spec files: ${conflicts.join(", ")}. ` +
        "Move repo-specific drafts outside the governed specs directory or re-run with --force."
    );
  }
}

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Drop a .mcp.json so MCP-capable agents (Claude Code etc.) in this repo can query
 * the registry and file feedback natively. Existing files are left untouched.
 */
function writeMcpConfig(server: string, projectType: string, repo: string, token?: string): void {
  const mcpPath = path.resolve(process.cwd(), ".mcp.json");
  if (fs.existsSync(mcpPath)) {
    console.log(".mcp.json already exists; not overwriting (add a 'specregistry' server manually if wanted).");
    return;
  }
  fs.writeFileSync(
    mcpPath,
    JSON.stringify(
      {
        mcpServers: {
          specregistry: {
            command: "specreg",
            args: ["mcp"],
            env: {
              SPECREG_SERVER: server,
              SPECREG_PROJECT_TYPE: projectType,
              SPECREG_REPO: repo,
              ...(token ? { SPECREG_TOKEN: token } : {}),
            },
          },
        },
      },
      null,
      2
    ) + "\n"
  );
  console.log("Wrote .mcp.json — AI agents in this repo can now read specs and file feedback via MCP.");
}

function writeAgentsBootstrap(server: string, projectType: string, repo: string, specDir: string, skillDir: string): void {
  const agentsPath = path.resolve(process.cwd(), "AGENTS.md");
  if (fs.existsSync(agentsPath)) {
    const existing = fs.readFileSync(agentsPath, "utf8");
    if (!existing.includes("generated by SpecRegistry")) {
      console.log("AGENTS.md already exists and is not SpecRegistry-generated; not overwriting.");
      return;
    }
  }
  fs.writeFileSync(agentsPath, renderAgentsBootstrap(server, projectType, repo, specDir, skillDir), "utf8");
  console.log("Wrote AGENTS.md — bootstrap instructions point agents to SPECREGISTRY.md, MCP, specs, and governed skills.");
}

export function renderAgentsBootstrap(server: string, projectType: string, repo: string, specDir: string, skillDir: string): string {
  return `<!-- generated by SpecRegistry bootstrap — safe to replace with \`specreg compile --target agents\`. -->

# Repository Agent Instructions

This repository is governed by SpecRegistry.

Before editing code, configuration, tests, docs, or generated artifacts:

1. Read \`SPECREGISTRY.md\` for the repository governance workflow.
2. Use the \`specregistry\` MCP server from \`.mcp.json\`; it runs \`specreg mcp\`.
3. Run \`specreg check\` and stop if governed specs are stale, missing, or locally modified.
4. Call MCP \`begin_task\` for the task, project type \`${projectType}\`, and repo \`${repo}\`.
5. Call MCP \`get_specs\` for project type \`${projectType}\` and repo \`${repo}\`.
6. Load relevant governed procedures from \`${skillDir}/\` before performing their workflow.
7. Use MCP \`search_specs\` and \`resolve_guidance\` before guessing missing standards.
8. Report unclear, contradictory, outdated, or missing-intent specs with \`report_spec_feedback\`.
9. Before claiming completion, call MCP \`finish_task\` with the \`session_id\` from \`begin_task\` or run \`specreg comply\`. Use MCP \`check_compliance\` for direct compliance checks.

Local governance files:

- Registry: ${server}
- Project type: ${projectType}
- Project/repo: ${repo}
- Governed specs: \`${specDir}/\`
- Manifest: \`${specDir}/.specregistry.json\`
- MCP config: \`.mcp.json\`
- Full guide: \`SPECREGISTRY.md\`
- Governed skills: \`${skillDir}/\`

This bootstrap file intentionally points to the live governance sources. To expand it into
a full compiled spec bundle, run:

\`\`\`sh
specreg compile --target agents
\`\`\`
`;
}

function writeRegistryGuide(
  server: string,
  projectType: string,
  repo: string,
  specDir: string,
  token?: string,
  styleGuides: InstalledStyleGuide[] = [],
  styleguideDir = ".spec/styleguides",
  skills: AgentSkill[] = [],
  skillDir = ".spec/skills"
): void {
  const guidePath = path.resolve(process.cwd(), "SPECREGISTRY.md");
  if (fs.existsSync(guidePath)) {
    console.log("SPECREGISTRY.md already exists; not overwriting.");
    return;
  }
  fs.writeFileSync(
    guidePath,
    `# SpecRegistry Repository Guide

This repository is governed by SpecRegistry.

## Active Spec Set

- Registry: ${server}
- Project type: ${projectType}
- Project/repo: ${repo}
- Governed specs directory: ${specDir}/
- Manifest: ${specDir}/.specregistry.json
${styleGuides.length > 0 ? `- External style guide directory: ${styleguideDir}/\n- External style guide manifest: ${styleguideDir}/google-styleguides.json\n` : ""}
${skills.length > 0 ? `- Governed agent skill directory: ${skillDir}/\n- Agent skill manifest: ${skillDir}/manifest.json\n` : ""}

Before changing code, complete the pre-implementation gate below. Treat the listed specs as
the approved source of truth. Generated repo-specific drafts belong outside the governed specs
directory until they are submitted through the registry review workflow.

## Pre-Implementation Gate

Do not edit code, configuration, tests, or generated artifacts until all of these are true:

1. Run \`specreg check\` and stop on drift, missing specs, or tampered governed files.
2. Start the \`specregistry\` MCP server from \`.mcp.json\`; it should run \`specreg mcp\`.
3. Call \`begin_task\` for the concrete task, project type \`${projectType}\`, and repo \`${repo}\`.
4. Call \`get_specs\` for project type \`${projectType}\` and repo \`${repo}\`.
5. Load every relevant governed skill from \`${skillDir}/\` before performing that workflow.
6. If MCP is unavailable, use only the documented fallback API endpoints in this file,
   record that MCP was unavailable, and do not browse or probe the registry server.

## Access Boundaries

Interact with the registry **only** through the \`specregistry\` MCP server and the documented
agent API endpoints listed under "MCP" below. Everything an agent needs is exposed there or in
the local spec bundle under \`${specDir}/\`.

Do not:
- browse, log into, or scrape the web dashboard;
- enumerate, probe, or fuzz server endpoints beyond the documented agent API;
- inspect the registry's database, filesystem, logs, or internal/admin routes.

If something you need is missing or unclear, call \`report_spec_feedback\` instead of exploring
the server. Treating the registry as a general-purpose host to investigate is out of scope.

## Identity & Approvals

This repo has its own **agent identity** (token in \`.spec/credentials.json\`, gitignored); the
\`specreg\` CLI and the MCP server use it automatically. Authenticate only as this agent —
**never log in as \`admin\`** or any human account, and never look for shared credentials.

You may freely create, edit, and publish **project-scoped** specs for this repo (e.g. its own
\`DESIGN.md\` / \`STRUCTURE.md\` details). You may **propose** changes to global and project-type
specs via the review workflow, but you **cannot approve or publish** them — approval is a human
action performed outside your tools. Never attempt to approve your own changes. Submit, then stop
and let a human review; do not try to escalate privileges to get something merged.

## Verifying Completion

Before you report a task as done, run the completion gate and keep working until it passes:

- Call \`finish_task\` (MCP) with the \`session_id\` returned by \`begin_task\`, or run
  \`specreg comply\` (regenerates the trace, checks, and exits non-zero when not compliant).
  Pass your honest self-assessed score. Use \`check_compliance\` for direct compliance checks
  when you do not need session lifecycle tracking.
- The registry decides compliance **objectively** (traceability coverage, drift, unmapped
  entities against this project's policy). Claiming "100%" yourself is not enough — over-claims
  are flagged. If the verdict is NOT COMPLIANT, address the listed outstanding items
  (e.g. add inline \`// @spec[FILE#section]\` annotations, link unmapped routes/schemas) and
  re-run the check. Loop until it reports compliant; only then report the task complete.
${styleGuides.length > 0 ? `
## External Style Guides

The following Google style guides were selected during \`specreg init\` and converted to
Markdown for local agent context. They are advisory process inputs, not registry-governed
spec versions:

${styleGuides.map((guide) => `- ${guide.title}: \`${guide.path}\``).join("\n")}

Use these guides when editing matching code or documentation, but report conflicts through
SpecRegistry feedback instead of silently overriding governed specs.
` : ""}
${skills.length > 0 ? `
## Agent Skills

The registry selected these governed operating procedures for this project:

${skills.map((skill) => `- ${skill.name} [${skill.risk_level}]: \`${skillDir}/${skill.slug}/SKILL.md\``).join("\n")}

Load a relevant skill before performing its workflow. Skills organize approved procedures;
they do not grant permission for destructive, privileged, or external actions. Follow the
agent host's approval policy and current published specs.
` : ""}

## MCP

Use the \`specregistry\` MCP server from \`.mcp.json\`; generated configs run \`specreg mcp\`
so the dashboard-downloaded CLI also provides the MCP server.
${token ? "Authentication is configured through `SPECREG_TOKEN` in `.mcp.json`.\n" : "If the registry requires auth, add `SPECREG_TOKEN` to `.mcp.json`.\n"}
Required MCP flow:

1. Call \`begin_task\` for the concrete task, project type \`${projectType}\`, and repo \`${repo}\`.
2. Call \`get_specs\` for project type \`${projectType}\` and repo \`${repo}\`.
3. Use \`search_specs\` for focused questions.
4. Before writing in a language or working in a domain the loaded specs do not cover
   (e.g. a new language, or networking/auth/database work), call \`resolve_guidance\`
   with the language(s) and/or topic. It returns the governed specs that apply and the
   styleguides you can pull, or an explicit gap.
5. Report ambiguity, contradiction, or outdated guidance with \`report_spec_feedback\`.
6. Call \`finish_task\` with the \`session_id\` returned by \`begin_task\` before claiming completion.
7. Use \`specreg check\` to verify this repo is still using current approved spec versions.

## Missing Guidance

If you are about to work in a language or domain that is not covered by the loaded specs
or styleguides, **acquire the proper guidance instead of inventing a standard**:

- Run \`resolve_guidance\` (MCP) to see what applies and what is missing.
- Pull a missing language styleguide on demand: \`specreg styleguide add <id|language>\`
  (e.g. \`specreg styleguide add go\`). \`specreg styleguide list\` shows the catalog.
- If no spec or styleguide covers the area, call \`report_spec_feedback\` and (if appropriate)
  draft one with \`specreg generate\` for review. Do not guess the missing rule.

If the MCP server is unavailable, the same data is available over the documented agent API —
and only these endpoints:

- \`GET ${server}/api/v1/ai/specs/${encodeURIComponent(projectType)}\` — current governed specs.
- \`GET ${server}/api/v1/ai/search?q=...\` — focused section search.
- \`POST ${server}/api/v1/ai/resolve-guidance\` — resolve styleguides/specs for a language or topic.
- \`POST ${server}/api/v1/ai/agent-sessions/begin\` — register preflight and get a session id.
- \`POST ${server}/api/v1/ai/agent-sessions/finish\` — record completion evidence and run the completion gate.
- \`POST ${server}/api/v1/ai/feedback\` — report a spec problem.

Use the \`specreg\` CLI for everything else (\`check\`, \`sync\`, \`compile\`, \`verify\`,
\`styleguide add\`). Do not call other server routes directly.
`,
    "utf8"
  );
  console.log("Wrote SPECREGISTRY.md — agents should use the MCP server and documented agent API only.");
}
