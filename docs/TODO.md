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

Remaining AST/code metadata work:

- [ ] Expand AST tagging coverage: add deeper module/import graphs, config keys, commands,
  background jobs, migrations, dependency edges, API shapes, schema fields, and more
  language-specific parsers beyond the initial TypeScript/JavaScript, Python, and SQL slice.
- [ ] Harden stable code ID generation for rename/move detection and incremental updates,
  including alias history, similarity matching, deleted entity retention, and merge behavior
  when a code entity is split or combined.
- [ ] Metadata injection workflow beyond sidecars: optionally write traceability metadata into
  source-adjacent manifests or reviewable inline comments/annotations for projects that
  explicitly allow source modification.
- [ ] Code-to-spec traceability graph: link code IDs to governing spec IDs, versions,
  sections, requirements, audit prompts, and examples. Support manual overrides and agent
  feedback when automatic matching is wrong or incomplete.
- [ ] Semantic drift pipeline: summarize changed code entities in CI, embed structural intent,
  compare against active spec vectors/code-profile vectors, and publish a telemetry drift
  score (0.0 to 1.0) to reports and `/metrics`.
- [ ] Code/AST embedding profile: add a separate embedding configuration for parsed code
  symbols, module summaries, dependency edges, API shapes, schemas, and architectural intent
  so AST drift and code-to-spec matching can use different models from spec text search.
- [ ] Code-to-spec coverage reports: show which files, modules, routes, APIs, schemas, jobs,
  commands, and config areas are governed by which specs, and highlight code with no matching
  spec coverage or specs with no implementation evidence.

## Enterprise

- Secrets hygiene with encrypted-at-rest LDAP bind passwords and webhook secrets.
- Read-only public share links for approved spec bundles.
- SCIM or scheduled LDAP user/group sync.
