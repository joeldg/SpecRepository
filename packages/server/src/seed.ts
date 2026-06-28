import type { Db } from "./db.js";
import { now, uuid } from "./db.js";
import { createUser } from "./lib/auth.js";
import { auditPromptForSpec } from "./lib/specAutomation.js";

const DESIGN_STUB = `You are an expert software architect. Analyze the provided file structure and codebase context:
[CONTEXT]

Generate a comprehensive DESIGN.md file conforming to the standard template. The output must detail:
1. System Architecture and component interactions.
2. High-level design patterns implemented.
3. Data flow patterns.

The project is of type "[PROJECT_TYPE]" and primarily uses: [LANGUAGES].

Output strict markdown. Do not include chat conversational text.`;

const STRUCTURE_STUB = `You are an AI system specialized in codebase mapping. Analyze the following directory tree and file signatures:
[TREE]

Generate a STRUCTURE.md file that maps out:
1. Core directory purposes.
2. Entry points and configuration files.
3. Dependency mapping between modules.

The project is of type "[PROJECT_TYPE]" and primarily uses: [LANGUAGES].

Output strict markdown. Avoid fluff.`;

interface SeedSpec {
  filename: string;
  content: string;
}

const BASELINE_REQUIRED_SECTIONS = [
  "Scope",
  "Intent",
  "Requirements",
  "Non-Goals",
  "Acceptance Evidence",
  "Token Budget Class",
  "Related Specs",
  "AI Agent Directives",
] as const;

const SPECREGISTRY_OPERATING_BASELINE: SeedSpec[] = [
  {
    filename: "SDD_OPERATING_MODEL.md",
    content: `# SDD Operating Model

## Scope
This specification applies to every repository, project type, global spec, project-scoped spec, and agent workflow governed by SpecRegistry.

## Intent
Spec Driven Development succeeds only when implementation work is traceable to current, reviewed, measurable specifications. The registry is the control plane for that loop, not a passive document store.

## Requirements
1. Every governed repository must initialize through \`specreg init\` or an equivalent reviewed automation path.
2. Every implementation task must identify the current governed spec set before code, configuration, tests, or generated artifacts are changed.
3. Local governed specs must come from the registry bundle and manifest, not from hand-edited local files.
4. Drift reported by \`specreg check\` is a blocking SDD failure until synchronized, explicitly waived, or resolved by reviewed spec changes.
5. Generated draft specs must remain outside the governed \`specs/\` directory until submitted through the registry workflow.
6. Ambiguity, contradiction, outdated guidance, or missing coverage must be reported as spec feedback instead of guessed around.
7. Spec changes must use review, approval policy, semver classification, audit log, and publish workflow before they become active guidance.

## Non-Goals
This spec does not define technology-specific architecture, coding style, or runtime behavior. Project-type and project-scoped specs define those contracts.

## Acceptance Evidence
- A repository contains \`specs/.specregistry.json\` from the registry.
- CI runs \`specreg check\` and fails on manifest, signature, or version drift.
- Review summaries cite affected specs or state that a gap was reported.
- Generated drafts appear under \`.spec/drafts\` or the registry draft workflow, not as direct edits to governed specs.

## Token Budget Class
Global invariant. Keep loaded by default for agents because it defines how all other specs are trusted.

## Related Specs
- \`AGENT_OPERATING_RULES.md\`
- \`SPEC_GOVERNANCE.md\`
- \`TRACEABILITY_AND_OBSERVABILITY.md\`

## AI Agent Directives
Before implementation, load governed specs through MCP or generated context. If drift is detected, stop and ask for synchronization. If a required spec is missing or contradictory, file feedback and do not invent the missing rule.
`,
  },
  {
    filename: "AGENT_OPERATING_RULES.md",
    content: `# Agent Operating Rules

## Scope
This specification applies to AI agents, coding assistants, automation scripts, and MCP clients that read, search, compile, generate, audit, or modify work governed by SpecRegistry.

## Intent
Agents should make SpecRegistry usage repeatable and observable. They must load the right context, minimize token waste, cite governed guidance, and report spec problems rather than silently substituting model judgment.

## Requirements
1. Agents must use the SpecRegistry MCP server when available and call \`get_specs\` before non-trivial work.
2. Agents should use \`search_specs\` for focused context before loading large reference specs into a prompt.
3. Before writing in a language or working in a domain the loaded specs do not cover, agents must call \`resolve_guidance\` (or the documented agent API) to pull the proper styleguide/spec; if coverage is missing, file feedback and acquire or draft guidance instead of inventing a standard.
4. In repo-specific work, agents must set or respect \`SPECREG_REPO\` so project-scoped specs can override project-type guidance.
5. In auth-required deployments, agents must use \`SPECREG_TOKEN\` and never print or commit it.
6. Agents must cite relevant spec filenames and sections in summaries when a change is materially governed by those specs.
7. Agents must call \`report_spec_feedback\` or the feedback API for ambiguity, contradiction, outdated guidance, or missing requirements.
8. Agents must distinguish approved specs from drafts, examples, local style guides, and generated prompts.
9. Agents must not claim checks passed unless they actually ran and observed the result.
10. Agents must reach the registry only through the MCP server, the documented agent API (\`get_specs\`, \`search_specs\`, \`resolve_guidance\`, \`report_spec_feedback\`), and the \`specreg\` CLI. They must not browse the web dashboard, enumerate or probe other server routes, or inspect the registry's database, filesystem, or internals.
11. Agents must authenticate only with their own enrolled agent identity. They must never log in as \`admin\` or a human account, never seek shared credentials, and never escalate privileges to merge a change.
12. Agents may create, edit, and publish project-scoped specs for their own repo, but must only **propose** changes to global and project-type specs. They must never approve or publish a change they proposed; approval is a human action and separation of duties is enforced by the server.
13. Before declaring a task complete, agents must run the compliance check (\`check_compliance\` via MCP, or \`specreg comply\`) and continue working until it reports compliant. A self-assessment of "done" is not sufficient; the registry's objective coverage/drift gate decides. Agents must not claim completion while the check still reports outstanding items.

## Non-Goals
This spec does not grant an agent permission to access production, secrets, protected branches, or external systems. Host approval and least-privilege rules still apply.

## Acceptance Evidence
- Agent output references the active registry URL or MCP config.
- Work summaries cite specs or explain why no governing spec applied.
- Feedback records exist for unclear or conflicting guidance.
- Auth-required MCP clients include a token path without exposing token values.

## Token Budget Class
Workflow rule. Load by default for agents, but keep concise and operational.

## Related Specs
- \`SDD_OPERATING_MODEL.md\`
- \`TOKENOMICS.md\`
- \`IMPLEMENTATION_EVIDENCE.md\`

## AI Agent Directives
Use governed specs as authority. Prefer registry search over broad context loading. Stop on missing or conflicting guidance. Never treat local generated files or examples as published specifications. Stay within the MCP tools, documented agent API, and \`specreg\` CLI — do not explore or probe the registry server itself.
`,
  },
  {
    filename: "SPEC_AUTHORING_STANDARD.md",
    content: `# Spec Authoring Standard

## Scope
This specification applies to all Markdown specifications authored, generated, reviewed, or published through SpecRegistry.

## Intent
Specs should constrain implementation, preserve intent, and earn their prompt budget. A good spec is specific enough to audit and short enough to use.

## Requirements
1. Every spec must state its scope and the outcome it protects.
2. Every spec must separate requirements from examples, references, and non-goals.
3. Every normative rule must be testable, auditable, or reviewable as evidence.
4. Every spec should include acceptance evidence describing how humans, CI, or agents verify conformance.
5. Specs must identify their token budget class: global invariant, project contract, workflow rule, reference detail, or temporary migration.
6. Specs that intentionally narrow or override broader guidance must say so explicitly and name the broader spec.
7. Generated specs must be reviewed for intent, contradictions, examples, and token cost before publication.
8. Specs should avoid volatile implementation details unless those details are the contract.

## Non-Goals
This spec is not a writing style guide for prose polish. It defines the minimum structure required for governed, observable SDD.

## Acceptance Evidence
- New specs contain scope, intent, requirements, non-goals, acceptance evidence, token budget class, related specs, and AI directives.
- Reviewers can identify at least one concrete way to audit each requirement.
- Search results can return meaningful sections because headings are specific.

## Token Budget Class
Global invariant. Load by default for spec generation, review, and draft-fix work.

## Related Specs
- \`SPEC_GOVERNANCE.md\`
- \`TOKENOMICS.md\`
- \`TRACEABILITY_AND_OBSERVABILITY.md\`

## AI Agent Directives
When generating or editing specs, preserve the required sections. Do not convert examples into requirements unless the user or reviewer explicitly asks for that contract.
`,
  },
  {
    filename: "SPEC_GOVERNANCE.md",
    content: `# Spec Governance

## Scope
This specification applies to review, approval, publication, promotion, deletion, and downstream synchronization of governed specs.

## Intent
SpecRegistry must make rule changes deliberate, reviewable, versioned, and explainable. A spec is source-of-truth only after it passes governance.

## Requirements
1. Draft specs may be edited directly until submitted for review or published.
2. Published specs must change through change requests, not direct mutation.
3. Semver deltas must match impact: major for breaking or removed guidance, minor for new compatible guidance, patch for clarifications.
4. Reviewers must inspect diff, compatibility, contradiction findings, impact analysis, required approvals, and migration checklist before publication.
5. Project-scoped specs may override only the attached repository and must not silently change a project type's shared baseline.
6. Global specs apply to every project type unless a reviewed project-type or project-scoped spec explicitly narrows the rule.
7. Deletions must preserve audit history and must not be treated as proof that old implementations were compliant.
8. Webhooks, sync jobs, and downstream PRs must carry enough summary context for consumers to verify the change.

## Non-Goals
This spec does not define individual reviewer identities or approval counts. Approval policies define those details.

## Acceptance Evidence
- Published changes have change request records, approvals, semver delta, and audit log entries.
- Publish preview identifies affected consumers, dependencies, feedback, usage, and migration steps.
- Project-scoped specs appear in reports as project-specific, not project-type-wide.

## Token Budget Class
Workflow rule. Load for spec review, approval, publishing, and migration tasks.

## Related Specs
- \`SDD_OPERATING_MODEL.md\`
- \`SPEC_AUTHORING_STANDARD.md\`
- \`IMPLEMENTATION_EVIDENCE.md\`

## AI Agent Directives
Do not bypass the registry workflow. When a requested spec edit affects published guidance, submit a review or draft according to the existing lifecycle instead of overwriting governed files.
`,
  },
  {
    filename: "TRACEABILITY_AND_OBSERVABILITY.md",
    content: `# Traceability and Observability

## Scope
This specification applies to manifests, MCP/spec reads, searches, feedback, audits, code trace reports, metrics, and reports that explain whether SDD is working.

## Intent
The registry must show which specs governed which work, whether code is covered by specs, when specs drift or conflict, and when a spec is followed literally but fails to express the intended outcome.

## Requirements
1. Governed repositories must report manifest usage through \`specreg check\`, \`specreg sync\`, or equivalent automation.
2. Repositories should run \`specreg code-map --report\` when code metadata is available so implementation surfaces can be linked to specs.
3. Reports must expose project spec drift, code-to-spec coverage, code drift severity, unmapped code entities, open feedback, pending reviews, stale specs, and token ROI signals.
4. Feedback must preserve spec, version, actor/agent, issue type, description, and context evidence.
5. Audit prompts and conformance audits should cite exact spec sections when possible.
6. Metrics endpoints must expose SDD health signals in a form Prometheus/Grafana can scrape or receive through an approved collector.
7. Traceability sidecars must not rewrite source files unless an explicit inline metadata workflow is enabled and reviewed.
8. Perfect spec compliance with wrong user or operational outcome must be recorded as a spec flaw or missing-intent feedback.

## Non-Goals
This spec does not require surveillance of developer behavior. It requires explainable evidence for governed decisions and repeated SDD failures.

## Acceptance Evidence
- Reports show current manifest consumers and code trace summaries.
- \`.spec/code-trace.json\` includes links, coverage, drift, aliases, and unmapped entities when generated.
- Feedback clusters can be triaged into spec changes, code changes, or intentional waivers.
- Metrics include registry, review, usage, and SDD health counts.

## Token Budget Class
Global invariant plus reporting contract. Load for audit, reports, CI, and governance work; search-first for detailed telemetry tables.

## Related Specs
- \`SDD_OPERATING_MODEL.md\`
- \`IMPLEMENTATION_EVIDENCE.md\`
- \`TOKENOMICS.md\`

## AI Agent Directives
When work changes code structure, APIs, schemas, commands, or config, prefer generating a code trace report and mention unmapped entities. Report missing spec coverage instead of pretending all code is governed.
`,
  },
  {
    filename: "TOKENOMICS.md",
    content: `# Tokenomics

## Scope
This specification applies to how specs are loaded, searched, summarized, split, promoted, demoted, and evaluated for usefulness in agent workflows.

## Intent
Spec context is a scarce budget. Specs must earn their tokens by improving decisions, reducing ambiguity, and preventing drift without overwhelming agents.

## Requirements
1. Always-loaded specs must be compact, stable, and broadly applicable.
2. Large reference specs should be searchable and section-addressable rather than blindly loaded into every prompt.
3. Each spec must declare a token budget class and should be split when unrelated concerns compete for attention.
4. Token ROI should consider reads, searches, feedback frequency, efficacy lift, stale age, and audit findings.
5. Specs with repeated ambiguity feedback or low efficacy lift must be candidates for revision, splitting, or demotion to reference material.
6. Agent workflows should prefer focused search results for task-specific detail.
7. Generated context files must not hide drift or replace the signed manifest as the authority.
8. Temporary migration guidance must include a review or expiration expectation.

## Non-Goals
This spec does not minimize tokens at the expense of safety, compliance, or correctness. Critical invariants may deserve default loading.

## Acceptance Evidence
- Specs declare token budget class.
- Reports expose token ROI, search/read counts, stale specs, and feedback trends.
- Large specs have headings that search can retrieve independently.
- Reviewers can justify why a spec is always-loaded or search-first.

## Token Budget Class
Global invariant for context economics. Load for spec authoring, agent context design, and report review.

## Related Specs
- \`SPEC_AUTHORING_STANDARD.md\`
- \`AGENT_OPERATING_RULES.md\`
- \`TRACEABILITY_AND_OBSERVABILITY.md\`

## AI Agent Directives
Use the smallest governed context that can safely answer the task. If context is too broad, search specs by task terms and cite the retrieved sections.
`,
  },
  {
    filename: "IMPLEMENTATION_EVIDENCE.md",
    content: `# Implementation Evidence

## Scope
This specification applies to pull requests, change summaries, audit results, code trace reports, generated specs, and any delivery evidence attached to governed implementation work.

## Intent
Completed work should prove what changed, which specs governed it, what was verified, and what remains uncertain. Evidence prevents plausible but unverified compliance claims.

## Requirements
1. Change summaries must list relevant specs or state that a spec gap was reported.
2. Test, lint, build, audit, and code trace commands must be reported with actual outcomes.
3. Failed or skipped checks must be called out as residual risk, not omitted.
4. Work that changes APIs, schemas, commands, config, security posture, or architecture boundaries must include corresponding spec or feedback evidence.
5. Generated specs and examples must be reviewed separately from implementation evidence.
6. CI annotations should identify drift, unmapped code entities, stale local specs, and audit findings when available.
7. Reviewers must be able to trace acceptance evidence back to specific spec sections or explicit gaps.

## Non-Goals
This spec does not prescribe a single PR template. It defines the minimum evidence required for SDD confidence.

## Acceptance Evidence
- PR/change summaries include commands run and observed results.
- Code trace coverage is uploaded for repositories where \`specreg code-map --report\` is available.
- Missing or ambiguous specs create feedback items or draft specs rather than hidden assumptions.
- Migration checklists accompany breaking spec changes.

## Token Budget Class
Workflow rule. Load for implementation, review, CI, and audit tasks.

## Related Specs
- \`SDD_OPERATING_MODEL.md\`
- \`TRACEABILITY_AND_OBSERVABILITY.md\`
- \`SPEC_GOVERNANCE.md\`

## AI Agent Directives
Never say a check passed without observed output. Include spec mapping, commands run, failures, skipped checks, and remaining risks in the final work summary.
`,
  },
  {
    filename: "SECURITY_AND_SECRETS.md",
    content: `# Security and Secrets

## Scope
This specification applies to credentials, API keys, registry tokens, LDAP bind settings, webhook secrets, local LLM endpoints, hosted LLM providers, Docker deployments, and generated agent configuration.

## Intent
SpecRegistry must let agents and humans work with governed context without leaking credentials or confusing local development settings with deployable server settings.

## Requirements
1. Secrets must never be committed to source control, generated specs, compiled agent context, screenshots, logs, or code trace reports.
2. Auth-required registries must use \`SPECREG_TOKEN\` or explicit bearer tokens for CLI and MCP clients.
3. Generated MCP and agent pack content must use \`SPECREG_PUBLIC_URL\` or the externally reachable registry URL, not an unreachable bind address.
4. API keys configured in the UI must be obfuscated when displayed after save.
5. LDAP bind passwords, webhook secrets, LLM API keys, and app integration secrets must be treated as sensitive settings.
6. Local or network LLM endpoints must be explicit and must not silently send sensitive code/specs to unintended providers.
7. Docker deployments must document hostname, port, public URL, auth mode, token path, and persistent database volume.
8. Security contradictions must be reported as spec feedback before implementation proceeds.

## Non-Goals
This spec does not replace organization-specific security policy, threat modeling, or compliance requirements.

## Acceptance Evidence
- README/deployment docs show \`SPECREG_PUBLIC_URL\`, \`SPECREG_AUTH\`, and \`SPECREG_TOKEN\` paths.
- Saved secrets display only presence/obfuscated state.
- Agent-generated files do not contain raw tokens or keys.
- Security feedback is filed when global and project guidance conflict.

## Token Budget Class
Global invariant. Load by default because accidental secret leakage and auth drift are high-impact failures.

## Related Specs
- \`AGENT_OPERATING_RULES.md\`
- \`SDD_OPERATING_MODEL.md\`
- \`IMPLEMENTATION_EVIDENCE.md\`

## AI Agent Directives
Refuse to print, persist, or invent secrets. When configuring MCP, CLI, LLM, LDAP, Docker, or webhook behavior, preserve token indirection and call out missing auth or public URL settings.
`,
  },
  {
    filename: "PROJECT_PROFILE.md",
    content: `# Project Profile

## Scope
This specification defines the standard project-scoped profile that \`specreg init\` drafts for a concrete repository.

## Intent
A repository's profile captures the local choices that make generic project-type guidance specific: product intent, stack, data stores, runtime, deployment, compliance posture, agent skills, and explicit non-goals.

## Requirements
1. Every initialized repository should submit a project-scoped \`PROJECT_PROFILE.md\` draft for review.
2. The profile must identify project type, repository identity, lifecycle stage, users, platforms, languages, frameworks, databases, APIs, infrastructure, tests, observability, security, privacy, and non-goals.
3. The profile is not governed until reviewed and published.
4. Material changes to stack, platform, deployment, data stores, external interfaces, or compliance scope must update the profile through review.
5. Project profile guidance may narrow project-type guidance only for the attached repository and only when explicit.
6. Agents must not invent missing project profile choices; they must report ambiguity or ask for a reviewed profile change.

## Non-Goals
This profile is not a replacement for technical contract specs such as API, database, security, observability, or architecture specs.

## Acceptance Evidence
- \`specreg init\` creates a structured profile draft.
- The profile is submitted as project-scoped draft or review request.
- Reports show the concrete project as a consumer attached to a project type.
- Agent summaries respect published project-scoped profile constraints.

## Token Budget Class
Project contract. Load for the attached repository; do not load for unrelated repositories.

## Related Specs
- \`SDD_OPERATING_MODEL.md\`
- \`SPEC_GOVERNANCE.md\`
- \`AGENT_OPERATING_RULES.md\`

## AI Agent Directives
Treat a published project profile as repository-specific guidance. Treat an unpublished generated profile as draft evidence only. Report conflicts between profile choices and global or project-type specs.
`,
  },
];

export const SPECREGISTRY_OPERATING_BASELINE_FILENAMES = SPECREGISTRY_OPERATING_BASELINE.map((spec) => spec.filename);
export const SPECREGISTRY_BASELINE_REQUIRED_SECTIONS = [...BASELINE_REQUIRED_SECTIONS];

function insertProjectType(
  db: Db,
  name: string,
  scope: "global" | "project_type",
  industry: string | null,
  description: string | null
): string {
  const id = uuid();
  const ts = now();
  db.prepare(
    `INSERT INTO project_types (id, name, scope, industry, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, scope, industry, description, ts, ts);
  return id;
}

const DEFAULT_PROJECT_TYPES = [
  {
    name: "MCP Server / Agent Integration",
    industry: "AI / Developer Tools",
    description:
      "Model Context Protocol servers, agent tool schemas, prompt/context contracts, feedback loops, and agent onboarding.",
  },
  {
    name: "SaaS Backend API",
    industry: "Software / SaaS",
    description:
      "Multi-tenant APIs, authentication, database migrations, billing/webhooks, observability, rate limits, and compatibility contracts.",
  },
  {
    name: "CLI Tool / Developer Tooling",
    industry: "Developer Tools",
    description:
      "Command-line tools, flags, config files, exit codes, stdout/stderr contracts, CI behavior, and backwards compatibility.",
  },
  {
    name: "AI-SDD Governed Project",
    industry: "AI / Software Delivery",
    description:
      "Strict Spec Driven Development with tokenomics, spec conflict detection, audit prompts, agent feedback, and generated context rules.",
  },
  {
    name: "Data Platform / ETL Pipeline",
    industry: "Data Engineering",
    description:
      "Schemas, lineage, batch/stream processing, idempotency, backfills, PII handling, data quality checks, and warehouse contracts.",
  },
  {
    name: "Internal Admin Tool",
    industry: "Operations Software",
    description:
      "Dense operational dashboards, auditability, role-based access, data tables/forms, imports/exports, and repeatable workflows.",
  },
  {
    name: "Mobile App",
    industry: "Mobile Software",
    description:
      "iOS, Android, or React Native apps with offline behavior, permissions, app store release, analytics, crash reporting, and deep links.",
  },
] satisfies Array<{ name: string; industry: string; description: string }>;

function seedDefaultProjectTypes(db: Db): number {
  let inserted = 0;
  for (const projectType of DEFAULT_PROJECT_TYPES) {
    const existing = db
      .prepare("SELECT id FROM project_types WHERE name = ? COLLATE NOCASE")
      .get(projectType.name);
    if (existing) continue;
    insertProjectType(db, projectType.name, "project_type", projectType.industry, projectType.description);
    inserted++;
  }
  return inserted;
}

function insertPublishedSpec(db: Db, projectTypeId: string, spec: SeedSpec): void {
  const id = uuid();
  const ts = now();
  const auditPrompt = auditPromptForSpec({
    id,
    filename: spec.filename,
    content: spec.content,
    current_version: "1.0.0",
  });
  db.prepare(
    `INSERT INTO specs (id, project_type_id, filename, current_version, status, content, updated_by, audit_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '1.0.0', 'published', ?, 'seed', ?, ?, ?)`
  ).run(id, projectTypeId, spec.filename, spec.content, auditPrompt, ts, ts);
  db.prepare(
    `INSERT INTO spec_versions (id, spec_id, version, content, published_by, published_at)
     VALUES (?, ?, '1.0.0', ?, 'seed', ?)`
  ).run(uuid(), id, spec.content, ts);
}

function insertPublishedSpecIfMissing(db: Db, projectTypeId: string, spec: SeedSpec): boolean {
  const existing = db
    .prepare("SELECT id FROM specs WHERE project_type_id = ? AND project_id IS NULL AND filename = ? AND deleted_at IS NULL")
    .get(projectTypeId, spec.filename);
  if (existing) return false;
  insertPublishedSpec(db, projectTypeId, spec);
  return true;
}

function seedOperatingBaseline(db: Db, globalId?: string): number {
  const global =
    globalId ??
    (db.prepare("SELECT id FROM project_types WHERE scope = 'global' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id;
  if (!global) return 0;
  let inserted = 0;
  for (const spec of SPECREGISTRY_OPERATING_BASELINE) {
    if (insertPublishedSpecIfMissing(db, global, spec)) inserted++;
  }
  return inserted;
}

/** Default conformance templates; seeded independently so existing databases pick them up. */
function seedTemplates(db: Db): void {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM spec_templates").get() as { n: number };
  if (existing.n > 0) return;
  const insert = db.prepare(
    `INSERT INTO spec_templates (id, filename, required_sections, content_template, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const ts = now();
  insert.run(
    uuid(),
    "DESIGN.md",
    JSON.stringify(["System Architecture", "Design Patterns", "Data Flow"]),
    `# <Project> — Design Specification

## System Architecture

_Describe the components and how they interact._

## Design Patterns

_List the high-level patterns in use and why._

## Data Flow

_Describe how data moves through the system._
`,
    "Every DESIGN.md must document architecture, patterns, and data flow.",
    ts,
    ts
  );
  insert.run(
    uuid(),
    "STRUCTURE.md",
    JSON.stringify(["Entry Points"]),
    `# <Project> — Repository Structure

| Path | Purpose |
| --- | --- |
| \`src/\` | _purpose_ |

## Entry Points

_List the main entry points and configuration files._
`,
    "Every STRUCTURE.md must map directories and list entry points.",
    ts,
    ts
  );
}

/** Bootstrap admin for local auth; password from SPECREG_ADMIN_PASSWORD (default "admin"). */
function seedAdmin(db: Db): void {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (existing.n > 0) return;
  createUser(db, {
    username: "admin",
    role: "admin",
    password: process.env.SPECREG_ADMIN_PASSWORD ?? "admin",
    display_name: "Administrator",
  });
}

/** Seeds the Acme demo configuration. No-op if any project type already exists. */
export function seed(db: Db): boolean {
  seedTemplates(db);
  seedAdmin(db);
  // Backfill missing audit prompts for existing specs (runs once after migration 15)
  const missing = db.prepare("SELECT COUNT(*) AS n FROM specs WHERE (audit_prompt IS NULL OR audit_prompt = '') AND deleted_at IS NULL").get() as { n: number };
  if (missing.n > 0) {
    const specs = db.prepare("SELECT id, filename, content, current_version FROM specs WHERE (audit_prompt IS NULL OR audit_prompt = '') AND deleted_at IS NULL").all() as Array<{
      id: string;
      filename: string;
      content: string;
      current_version: string;
    }>;
    const update = db.prepare("UPDATE specs SET audit_prompt = ?, updated_at = ? WHERE id = ?");
    for (const spec of specs) {
      const prompt = auditPromptForSpec(spec);
      update.run(prompt, now(), spec.id);
    }
  }

  const existing = db.prepare("SELECT COUNT(*) AS n FROM project_types").get() as { n: number };
  if (existing.n > 0) {
    seedDefaultProjectTypes(db);
    seedOperatingBaseline(db);
    return false;
  }

  const globalId = insertProjectType(
    db,
    "Global",
    "global",
    null,
    "Organization-wide specifications that apply to every project type."
  );
  insertPublishedSpec(db, globalId, {
    filename: "GLOBAL_SECURITY.md",
    content: `# Global Security Standards

## Scope
These rules apply to every project in the organization, regardless of project type.

## Requirements
1. **Secrets** must never be committed to source control. Use the approved secret manager.
2. **Dependencies** must be pinned and scanned weekly for CVEs.
3. **Network services** must default to TLS 1.2+ and deny-by-default firewall rules.
4. **Authentication** flows must be reviewed by the security team before release.

## AI Agent Directives
AI agents generating code MUST refuse to embed credentials and MUST flag any spec
contradiction via the feedback endpoint rather than guessing.
`,
  });
  insertPublishedSpec(db, globalId, {
    filename: "CODING_STANDARDS.md",
    content: `# General Coding Standards

## Principles
- Prefer clarity over cleverness; code is read far more than it is written.
- Every public interface requires documentation in the repository's spec files.
- All changes ship with tests that exercise the changed behavior.

## Versioning
All specification documents follow strict Semantic Versioning (MAJOR.MINOR.PATCH).
Breaking guidance changes are MAJOR; new guidance is MINOR; clarifications are PATCH.

## Reviews
No specification becomes active without an approved review in SpecRegistry.
`,
  });
  seedOperatingBaseline(db, globalId);

  const edgeId = insertProjectType(
    db,
    "Acme Edge Device",
    "project_type",
    "Aerospace/Telecommunications",
    "Phased-array antenna edge devices: embedded controllers, RF front-end management."
  );
  insertPublishedSpec(db, edgeId, {
    filename: "DESIGN.md",
    content: `# Acme Edge Device — Design Specification

## System Architecture
Edge devices are composed of three planes:
1. **Control plane** — supervisory MCU coordinating beam steering and health telemetry.
2. **Data plane** — RF front-end with FPGA-based signal conditioning.
3. **Management plane** — out-of-band service interface for fleet operations.

## Design Patterns
- State machines for mode transitions (ACQUIRE → TRACK → DEGRADED → SAFE).
- Watchdog-supervised tasks; no dynamic allocation after initialization.

## Data Flow
Telemetry flows MCU → management plane at 1 Hz; alarms are event-driven.
`,
  });
  insertPublishedSpec(db, edgeId, {
    filename: "STRUCTURE.md",
    content: `# Acme Edge Device — Repository Structure

| Path | Purpose |
| --- | --- |
| \`fw/\` | Embedded firmware (C/C++), one subdirectory per board |
| \`fpga/\` | HDL sources and constraint files |
| \`tools/\` | Host-side flashing, provisioning, and test utilities |
| \`docs/\` | Datasheets and interface control documents |

## Entry Points
- \`fw/<board>/main.c\` — firmware entry
- \`tools/provision.py\` — manufacturing provisioning

## Rules
- HDL and firmware interfaces must be kept in lockstep via \`docs/icd/\`.
`,
  });
  insertPublishedSpec(db, edgeId, {
    filename: "API.md",
    content: `# Acme Edge Device — Management API

## Transport
CoAP over DTLS on the management plane interface. JSON payloads, snake_case keys.

## Resources
- \`GET /telemetry\` — current beam state, temperatures, lock status
- \`POST /mode\` — request mode transition; body: { "target": "TRACK" }
- \`GET /health\` — watchdog counters and fault log tail

## Constraints
All commands must be idempotent; retries are expected on lossy links.
`,
  });

  const fwId = insertProjectType(
    db,
    "Acme Firmware",
    "project_type",
    "Aerospace/Telecommunications",
    "Shared firmware platform: RTOS components, drivers, and build infrastructure."
  );
  insertPublishedSpec(db, fwId, {
    filename: "DESIGN.md",
    content: `# Acme Firmware Platform — Design Specification

## System Architecture
A layered RTOS platform: board support packages at the bottom, a hardware
abstraction layer, shared services (logging, OTA, crypto), and application tasks.

## Design Patterns
- HAL interfaces are pure C headers with one implementation per target.
- Services communicate via message queues only; no shared mutable state.

## Data Flow
OTA images are signed and staged to the inactive bank; swap occurs on verified boot.
`,
  });
  insertPublishedSpec(db, fwId, {
    filename: "STRUCTURE.md",
    content: `# Acme Firmware Platform — Repository Structure

| Path | Purpose |
| --- | --- |
| \`bsp/\` | Board support packages |
| \`hal/\` | Hardware abstraction interfaces and implementations |
| \`services/\` | Logging, OTA, crypto, telemetry services |
| \`apps/\` | Application task sets per product |

## Build
CMake presets per target; \`ctest\` runs the host-side unit suite.
`,
  });

  const webId = insertProjectType(
    db,
    "Web App Standard",
    "project_type",
    "Software",
    "Standard internal web application stack: TypeScript, React, REST APIs."
  );
  insertPublishedSpec(db, webId, {
    filename: "DESIGN.md",
    content: `# Web App Standard — Design Specification

## System Architecture
Single-page React frontend, REST backend, relational store. Server-rendered
pages only where SEO requires it.

## Design Patterns
- API handlers are thin; domain logic lives in service modules.
- Frontend state: server state via fetch hooks, UI state local to components.

## Data Flow
All mutations go through the API layer; the frontend never writes to storage directly.
`,
  });
  insertPublishedSpec(db, webId, {
    filename: "STRUCTURE.md",
    content: `# Web App Standard — Repository Structure

| Path | Purpose |
| --- | --- |
| \`src/api/\` | Route handlers and request validation |
| \`src/services/\` | Domain logic |
| \`src/web/\` | React application |
| \`test/\` | Unit and integration tests |

## Entry Points
- \`src/index.ts\` — server entry
- \`src/web/main.tsx\` — frontend entry
`,
  });

  seedDefaultProjectTypes(db);

  const insertStub = db.prepare(
    `INSERT INTO stub_prompts (id, target_filename, template, description, project_type_id)
     VALUES (?, ?, ?, ?, NULL)`
  );
  insertStub.run(
    uuid(),
    "DESIGN.md",
    DESIGN_STUB,
    "Generates a DESIGN.md from codebase context for existing projects."
  );
  insertStub.run(
    uuid(),
    "STRUCTURE.md",
    STRUCTURE_STUB,
    "Generates a STRUCTURE.md from a directory tree for existing projects."
  );

  return true;
}
