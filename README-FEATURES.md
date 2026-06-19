# SpecRegistry Feature Inventory

This document summarizes the major features added and refined during the SpecRegistry build-out. It is intended as a quick product and engineering map: what each feature does, why it exists, and where it shows up in the app/API/CLI.

## Spec Governance Core

### Versioned Markdown Specs

SpecRegistry manages Markdown specification files as governed source-of-truth documents. Specs move through draft, review, approval, publication, immutable version snapshots, and semantic version bumps.

Why it matters: SDD only works when specs are durable, reviewed, versioned artifacts rather than loose repository notes.

### Review Workflow

Published specs change through change requests. Each request stores the proposed content, unified diff, requested version delta, lint report, compatibility report, contradiction report, risk score, approvals, and final published version.

Where it appears:

- Reviews page
- Review detail page
- `POST /api/v1/specs/review`
- `POST /api/v1/reviews/:id/approve`
- `POST /api/v1/reviews/:id/reject`

### Approval Policies and CODEOWNERS-Style Routing

Approval policies can require a minimum number of approvals and optional named reviewers by project type and filename glob.

Why it matters: security, API, deployment, or architecture specs can be routed to the right owners instead of relying on whoever sees the review first.

## Project and Distribution Model

### Global, Project-Type, and Project-Scoped Specs

Specs can apply globally, to a project type, or to one concrete repo/project consumer. Project-scoped specs override project-type specs for one repo without changing every consumer of that project type.

Why it matters: shared standards stay shared, while repo-specific constraints still become governed specs.

### Repo Consumers and Manifest Reporting

CLI operations report local `.specregistry.json` manifests back to the registry. The server tracks which repositories use which project type, which spec versions they have, and whether any are outdated.

Where it appears:

- Settings project table
- Reports project table
- Manifest drift diagnostics
- `POST /api/v1/cli/manifest-report`

### Signed Spec Bundles

Downloaded spec bundles include file hashes and an ed25519 manifest signature. The CLI can verify local files against the registry public key.

Why it matters: agents and CI can confirm that local specs came from the registry and were not silently modified.

## CLI and Agent Context

### `specreg init`

Initializes a repository with approved specs, writes `specs/.specregistry.json`, creates agent context files, and can install advisory Google style guides.

### `specreg check` and `specreg sync`

`check` detects drift between local specs and the registry. `sync` updates local specs and regenerates saved agent context targets.

Why it matters: drift is a governance failure in SDD. Code can be correct against an old spec and wrong against the current one.

### `specreg generate` and `submit-drafts`

The CLI can scan a repository, produce draft spec prompts or LLM-generated drafts, and submit generated drafts into the registry workflow.

Why it matters: new or existing repos can bootstrap governed specs without bypassing review.

### Compiled Agent Context

The registry can compile governed spec sets into agent-readable files:

- `CLAUDE.md`
- `AGENTS.md`
- `.cursorrules`

These files preserve the registry as the source of truth while supporting tools that do not use MCP.

### MCP Server

The `specreg-mcp` server lets MCP-capable agents:

- list project types
- load governed specs
- search specs
- report spec feedback
- fetch audit prompts

It supports `SPECREG_SERVER`, `SPECREG_PROJECT_TYPE`, `SPECREG_REPO`, and `SPECREG_TOKEN`.

### Agent Onboarding Packs

Agent packs bundle compiled context files, `.mcp.json`, and an MCP skill guide.

Why it matters: a repo can be made agent-ready with the right registry URL, auth token path, project type, and repo identity.

## SDD Observability and Reporting

### Granular Reports

The Reports page and `GET /api/v1/reports/overview` summarize SDD health across:

- global specs
- project types
- individual projects
- feedback mix
- scope mix
- stale specs
- pending reviews
- efficacy trends
- token ROI
- dependency-map health

### Manifest Drift Diagnostics

Admins can paste a `.specregistry.json` into Reports and immediately see:

- current vs local versions
- missing local specs
- local-only specs
- breaking drift
- whether a latest version is outside the manifest pin

Why it matters: drift can be diagnosed even before a repo has reported through the CLI.

### Impact Explorer

The Impact page lets users inspect any published spec outside the review flow. It shows:

- affected reported projects
- subscribed repos
- dependent specs
- open feedback
- recent usage
- impact score
- migration checklist
- generated PR summary markdown

Endpoint:

- `GET /api/v1/specs/:id/impact?delta=patch|minor|major`

### Review Impact Analysis

Review publish previews include blast-radius evidence before approval:

- manifest consumers
- repo subscriptions
- downstream spec references
- feedback counts
- recent usage
- impact score and level

Why it matters: reviewers can see who and what a spec change affects before publishing it.

### Migration Checklists

Spec changes generate downstream migration checklist items based on risk, compatibility, feedback, dependencies, and version delta.

Why it matters: consumers get concrete verification work, not only updated Markdown.

### Generated PR Summaries and Changelogs

GitHub sync PRs and review previews include PR-ready summaries with:

- file and version
- delta
- impact
- affected projects
- added/removed sections
- migration checklist
- changelog

## Search and Discovery

### FTS5 Section Search

Specs are indexed into section-level chunks. Search returns exact matching sections with stable anchors and permalinks.

Endpoint:

- `GET /api/v1/ai/search?q=...&mode=fts`

### Semantic Search

Spec sections can be embedded and searched by vector similarity. Supported embedding providers:

- local deterministic hash embeddings
- OpenAI
- Gemini
- OpenAI-compatible/local embedding endpoints

Where it appears:

- Search page mode selector
- Settings semantic search section
- `GET /api/v1/embeddings/status`
- `POST /api/v1/embeddings/reindex`

### Hybrid Search

Hybrid search combines exact FTS matches with semantic similarity. MCP `search_specs` defaults to hybrid.

Why it matters: agents can find relevant policy sections even when their query does not use the exact wording from the spec.

## AI Feedback and Efficacy

### Agent Feedback Loop

Agents can report ambiguities, contradictions, or outdated guidance against a specific spec/version.

Where it appears:

- AI Feedback page
- spec detail page
- `POST /api/v1/ai/feedback`
- MCP `report_spec_feedback`

### Feedback Clustering

Repeated feedback is clustered by spec, type, and complaint text. Clusters can be acknowledged, resolved, or used to draft a fix.

### AI Draft Fixes

A configured LLM can draft a spec revision from feedback. The result becomes a normal pending change request and still requires review.

### Reverse Conformance Audits

`specreg audit` and `POST /api/v1/ai/audit` ask the configured LLM whether a codebase snapshot follows the governed specs.

### Generated Audit Prompts

Each spec can produce a reverse-conformance prompt for agents or reviewers. Prompts can be deterministic or improved by the configured server LLM.

Where it appears:

- Spec detail page
- Generate Specs workbench
- MCP `get_audit_prompt`
- `GET /api/v1/automation/audit-prompt/:specId`

### Efficacy and Token ROI

Spec efficacy tests compare outputs with and without a spec in context. Token ROI reports help identify specs that cost prompt budget without improving outcomes.

Why it matters: a spec should earn its tokens.

## LLM Spec Automation

### Spec Gap Detector

Detects missing governance coverage from repo evidence, trees, manifests, existing specs, and project type templates.

### Spec Generation Workbench

The Generate Specs page can preview or create reviewed draft specs from purpose templates and optional server LLM generation.

### Purpose-Based Templates

Built-in generation purposes include:

- API contracts
- database schemas
- test strategies
- observability
- security/privacy
- deployment/runbooks
- AI agent operating rules

### Agent Task Planner

Given a task, the planner returns applicable specs, relevant sections, missing specs, acceptance criteria, and context selection under a token budget.

### Spec-Aware Ticket and PR Checklists

Produces implementation checklists derived from governing specs and task context.

### Improvement Suggestions

Suggests spec improvements based on feedback clusters, audit findings, weak efficacy, and low token ROI.

### Spec Pack Composer

Composes reusable spec packs for project families such as AI-SDD, SaaS backend, embedded systems, web apps, and data platforms.

### Context Budget Optimizer

Selects the highest-value spec sections for an agent task under a token budget.

### Feature Flags

Automation capabilities can be enabled or disabled with `SPECREG_AUTOMATION_*` environment flags.

## LLM Provider Support

### Server LLM Settings

The Settings page supports configuring three LLM tiers:

- cheap/local for classification, summarization, and planning
- standard for general automation
- frontier for spec generation, audits, draft fixes, and efficacy scoring

Each tier has its own provider, model, base URL, API key, token budget, model loader, and
connectivity test. A routing table maps product features to tiers so admins can move tasks
between local/network models and hosted frontier models without code changes.

Supported providers:

- Anthropic
- OpenAI
- Gemini
- OpenAI-compatible/local servers

The server LLM powers audit, draft fixes, efficacy, automation, and prompt generation.

### Local and Network LLM Servers

OpenAI-compatible mode supports LM Studio, Ollama, vLLM, LocalAI, and internal gateways.

Root URLs such as `http://10.0.0.142:1234` are normalized to `/v1` automatically for LM Studio-style servers.

### Model Loading and Testing

Settings can load available models from providers and run a test prompt. Saved API keys are hidden from the browser.

### CLI LLM Providers

The CLI `generate --write` flow supports multiple LLM providers, not only Anthropic.

## Integrations and Automation

### GitHub Action for Drift Checks

The composite GitHub Action runs `specreg check`, captures drift output, optionally comments on PRs, and can fail the workflow.

Path:

- `.github/actions/specreg-check/action.yml`

### GitHub Repo Subscriptions

Subscribed repos can receive spec update PRs when approved specs change.

### Inbound GitHub Sync

GitHub push webhooks can turn repo-side spec edits into registry change requests, keeping the registry as the review gate.

### Webhooks and Chat

SpecRegistry supports JSON, Slack, and Google Chat webhook formats. Slack interactive actions can approve or reject reviews.

## Authentication and Enterprise

### Local Users and API Keys

The server supports local users, roles, and API keys for CLI, CI, MCP, and automation.

Roles:

- admin
- reviewer
- author
- agent

### LDAP Login and Role Mapping

Settings expose LDAP configuration, a login tester, and role preview based on LDAP groups.

### Auth-Required Deployments

When `SPECREG_AUTH=required`, CLI and MCP clients can use `SPECREG_TOKEN` or `--token`.

## Deployment and Runtime

### Docker Compose

The project includes Docker deployment support with persistent SQLite storage and `SPECREG_PUBLIC_URL` awareness.

Why it matters: generated MCP config and agent packs must point at the URL reachable by developer machines and agents, not a container bind address.

### Prometheus Metrics

`GET /metrics` exposes Prometheus metrics for specs, reviews, feedback, usage events, sync jobs, users, approval policies, audit events, and efficacy runs.

### Grafana Alloy

Docker Compose includes an optional Grafana Alloy profile for scraping and remote-writing metrics.

### Audit Log

Governance-sensitive actions are recorded in `audit_log`, including settings changes, user/API-key changes, review actions, template changes, webhooks, subscriptions, and sync jobs.

## Current Remaining Backlog

The completed backlog is now broad. The major remaining items are:

- GitHub App integration instead of raw `GITHUB_TOKEN`
- saved searches for common policy areas
- encrypted-at-rest secrets for LDAP bind passwords and webhook secrets
- read-only public share links for approved spec bundles
- SCIM or scheduled LDAP user/group sync
