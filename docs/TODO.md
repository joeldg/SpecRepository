# SpecRegistry Add-On Backlog

## LLM Spec Automation

- [x] Spec gap detector that scans repo metadata and identifies missing governance specs.
- [x] Spec generation workbench for generating reviewed draft specs from repo scans, pasted trees, uploaded manifests, existing spec packs, or project type templates.
- [x] Purpose-based spec templates for API contracts, database schemas, test strategies, deployment/runbooks, observability, security/privacy, and agent operating rules.
- [x] Agent task planner that returns applicable specs, sections, missing specs, and acceptance criteria for a ticket or task.
- [x] Spec-aware PR/ticket generator that produces implementation checklists from governing specs.
- [x] Spec improvement suggestions based on feedback clusters, weak efficacy, audit findings, and low token ROI.
- [x] Spec pack composer for reusable global and project-type packs such as AI-SDD, SaaS backend, embedded systems, web app, and data platform packs.
- [x] Generated audit prompts per spec for reverse conformance checks.
- [x] Spec section classifier for invariants, acceptance criteria, examples, non-goals, operational requirements, security requirements, and reference detail.
- [x] Context budget optimizer that selects the highest-value specs/sections for an agent task under a token budget.

## Governance

- [x] Spec impact analysis before approval/publish, including affected manifest consumers,
  repo subscriptions, downstream spec references, feedback, recent usage, and risk level.

## Quality and Safety

- No open items.

## Developer Workflow

- [x] Project-local Google style guide onboarding during `specreg init`, with suggested
  multi-select, converted Markdown copies, and agent-discoverable guide manifests.
- [x] Official `specreg check` GitHub Action with optional PR comments.
- [x] Dashboard drift diagnostics from an uploaded or pasted `.specregistry.json`.
- GitHub App integration instead of raw `GITHUB_TOKEN`.
- [x] Generated spec update PR summaries and changelogs.
- [x] Spec change migration checklist generation for downstream projects.

## Search and Discovery

- [x] Semantic search alongside FTS5.
- Saved searches for common policy areas such as auth, PII, deployment, and observability.
- [x] Spec impact explorer for browsing dependencies, consumers, recent usage, and drift outside
  the review flow.

## AI Feedback and Efficacy

- No open items.

## Enterprise

- Secrets hygiene with encrypted-at-rest LDAP bind passwords and webhook secrets.
- Read-only public share links for approved spec bundles.
- SCIM or scheduled LDAP user/group sync.
