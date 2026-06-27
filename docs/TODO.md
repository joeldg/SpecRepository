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
- [x] Configurable LLM Tiering: Split LLM routing in settings to send simpler tasks (classification, simple linting, initial summarization) to a local/cheap LLM (e.g., Ollama, LM Studio) and complex tasks (spec generation, final audits, draft-fixes) to frontier/expensive models (Anthropic, OpenAI).

## Governance

- [x] Spec impact analysis before approval/publish, including affected manifest consumers,
  repo subscriptions, downstream spec references, feedback, recent usage, and risk level.
- LLM-assisted contradiction detection: current contradiction reports use deterministic
  normative-statement heuristics. Add an optional LLM/semantic pass that can catch
  paraphrased conflicts, policy collisions, and intent-level contradictions before review.

## Quality and Safety

- Persisted prompt regression suites: the `/ai/regression-suite` endpoint runs prompts
  on demand, but it does not yet store suites, baselines, expected outcomes, model/spec
  version comparisons, or pass/fail history in the UI.
- Scheduled efficacy runner: the current scheduled-run endpoint is an on-demand batch.
  Add real schedules with cadence, ownership, retries, last-run status, result history,
  and notifications.
- [ ] Architecture Boundary Violations Engine: Implement multi-language import graph checking (via dependency-cruiser for JS/TS, Import Linter for Python, and build-system/Bazel visibility rules or compiler checks for C++) alongside category-specific LLM auditing to detect and count layer boundary breaches in CI.

## Developer Workflow

- [x] Comprehensive guided new-project setup in `specreg init`, with custom stack choices,
  premade project-type fallback, structured profile output, and project-scoped draft submission.
- [x] Governed agent skill catalog with safe defaults, risk labels, admin registration,
  init-time selection, local `SKILL.md` installation, and generated-agent discovery guidance.
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

## AST Metadata and Code-to-Spec Traceability

Completed adjacent foundations:

- [x] Spec-text embeddings and semantic/hybrid search for governed spec sections.
- [x] Manifest/version drift checks for local spec bundles via `specreg check`, uploaded
  manifest diagnostics, and project/report drift summaries.
- [x] Repo metadata/spec gap detector that uses tree/manifests/evidence to suggest missing
  governance specs.
- [x] Prometheus metrics endpoint for registry, review, usage, and SDD health signals.
- [x] Initial `specreg code-map` sidecar metadata generator for TypeScript/JavaScript AST
  entities plus Python and SQL extraction. Writes `.spec/code-map.json` with stable code
  IDs, entity kinds, paths, signatures, source locations, parent links, hashes, and route
  metadata without rewriting source files.
- [x] Settings-backed feature controls for automation and AST/code metadata families, with
  Docker/server-friendly environment defaults and database overrides from the Settings UI.
- [x] Expanded code metadata tagging for imports, package commands, config surfaces,
  migrations, SQL fields, and schema objects.
- [x] Stable-ID alias reporting when a prior code-map exists and entities move, rename, or
  otherwise retain a hash/path-name relationship.
- [x] Source-adjacent metadata workflow via `.spec/code-map.json` and `.spec/code-trace.json`
  sidecars, preserving source files unless a future inline-injection mode is explicitly
  enabled.
- [x] Initial code-to-spec traceability graph linking parsed entities to local Markdown specs,
  including confidence and match reasons.
- [x] Initial semantic drift and coverage pipeline in the trace report, including a 0.0-1.0
  drift score, severity, unmapped entity list, and linked/unlinked coverage counts by kind.
- [x] Code/AST embedding profile guidance in `.spec/code-trace.json` for separating code
  entity summaries from spec-text embeddings.

Remaining AST/code metadata work:

- [ ] Deepen the traceability system with server ingestion, UI reports, CI annotations,
  manual override review, deleted-entity retention, split/merge history, richer dependency
  graphs, and additional language parsers.

## Enterprise

- Secrets hygiene with encrypted-at-rest LDAP bind passwords and webhook secrets.
- Read-only public share links for approved spec bundles.
- SCIM or scheduled LDAP user/group sync.
