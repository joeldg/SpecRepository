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

- [x] Built-in SpecRegistry Operating Baseline global specs covering strict SDD process,
  agent behavior, spec authoring, governance, traceability/observability, tokenomics,
  implementation evidence, security/secrets, and project profiles.
- [x] Spec impact analysis before approval/publish, including affected manifest consumers,
  repo subscriptions, downstream spec references, feedback, recent usage, and risk level.
- [ ] LLM-assisted contradiction detection: current contradiction reports use deterministic
  normative-statement heuristics. Add an optional LLM/semantic pass that can catch
  paraphrased conflicts, policy collisions, and intent-level contradictions before review.
- [ ] First-class "spec followed but intent missed" workflow and report type for cases
  where implementation technically complies but the user or operational outcome is wrong.

## Agent Access Control

- [x] Agent session registry: persist active/completed agent runs by repo, project type,
  task, model, MCP server, loaded spec bundle, preflight summary, completion evidence,
  compliance attestation, and timestamps.
- [x] MCP preflight gate (`begin_task`): require agents to register task intent, repo,
  model, plan, and loaded specs before non-trivial implementation work; return blockers,
  warnings, and the governed spec bundle.
- [x] MCP completion gate (`finish_task`): record completion evidence, wrap the objective
  compliance evaluator, update the session, and block completion claims until the
  compliance gate passes.
- [x] Advisory agent access boundaries: `SPECREGISTRY.md` and the `AGENT_OPERATING_RULES`
  governed spec now constrain agents to the MCP server, the documented agent API
  (`begin_task`, `get_specs`, `search_specs`, `finish_task`, `report_spec_feedback`),
  and the `specreg` CLI — no dashboard browsing, endpoint probing, or server-internals
  inspection.
- [x] Enforced secured posture: with `SPECREG_AUTH=required` the server refuses to boot while
  `admin` uses the default password (also catches `SPECREG_ADMIN_PASSWORD=admin`), and a fresh
  secured database auto-generates a strong admin password printed once. Converts the agent
  MCP/API boundary, RBAC, and separation of duties from advisory to server-enforced; agents
  authenticate with their enrolled `agent`-scoped token and cannot approve/publish/admin.
- [ ] Governed tool permission profiles by project/spec/task, covering allowed file edits,
  shell/network/dependency/database actions, destructive commands, LLM usage, and
  escalation expectations for the host agent.
- [ ] Task-intent to spec mapping: require agents to declare applicable specs/sections and
  compare that declaration to registry guidance to detect missed governing specs.
- [ ] Human intervention queue for failed compliance, conflicting specs, missing guidance,
  or ambiguous task intent instead of letting agents guess through blockers.
- [ ] Agent run timeline: event stream for loaded specs, selected skills, searches,
  generated files, commands/checks run, compliance iterations, feedback submitted, and
  final claims.
- [ ] Prompt-budget policy controls for agents, including required/optional/summarized spec
  tiers, max prompt budgets by task class, and token warnings for low-value context.
- [ ] Model/provider policy controls for agent task classes, such as cheap/local for
  classification, frontier for governance audits, and local-only for private repos.
- [ ] Spec conflict escalation workflow where agents submit contradictory clauses,
  affected specs, implementation impact, and proposed resolution path.
- [ ] Hard agent access enforcement: issue a scoped `agent`-role token during `specreg init`
  and wire `SPECREG_AUTH=required` into the init/MCP flow so the MCP/API limitation is
  enforced at the network layer, not just advised. Anything beyond the agent-tier endpoints
  is then rejected with 401/403 rather than relying on agent cooperation.
- [ ] Dedicated agent-scope token type (narrower than the `agent` role) that allows only
  documented lifecycle/spec/feedback endpoints plus manifest/code-trace telemetry, with
  per-repo issuance and revocation from the admin console.

## Quality and Safety

- [ ] Persisted prompt regression suites: the `/ai/regression-suite` endpoint runs prompts
  on demand, but it does not yet store suites, baselines, expected outcomes, model/spec
  version comparisons, or pass/fail history in the UI.
- [ ] Scheduled efficacy runner: the current scheduled-run endpoint is an on-demand batch.
  Add real schedules with cadence, ownership, retries, last-run status, result history,
  and notifications.
- [ ] Architecture Boundary Violations Engine: Implement multi-language import graph checking (via dependency-cruiser for JS/TS, Import Linter for Python, and build-system/Bazel visibility rules or compiler checks for C++) alongside category-specific LLM auditing to detect and count layer boundary breaches in CI.
- [ ] Spec baseline quality scoring for required sections, vague language, missing
  acceptance evidence, missing examples/non-goals, token budget mismatch, and repeated
  feedback against the same section.
- [ ] Bound the code-trace ingest payload explicitly: `raw_json` stores the whole untrusted
  trace (currently only capped by Fastify's default 1MB body limit). Add an explicit size
  cap / per-route body limit and dedupe the repeated `repo` reads in the handler.
- [ ] Gitignore generated/pulled init artifacts (`CLAUDE.md`, `SPECREGISTRY.md`, `specs/`,
  `.spec/`, `.mcp.json`) in consuming repos and document it, so demo/init output is not
  accidentally committed.

## Compliance Verification

- [x] Compliance verification loop: objective gate (`POST /ai/compliance-check`) on measured
  traceability coverage/drift/unmapped vs per-project-type policy, with recorded self-assessed
  score + over-claim flagging; `check_compliance` MCP tool, `specreg comply` (non-zero exit),
  attestation log, and an `AGENT_OPERATING_RULES` rule to loop until compliant.
- [x] Compliance dashboard panel: web UI view over `/api/v1/compliance-attestations` so humans
  can watch the self-healing loop per repo (iteration count, objective vs self-assessed score,
  latest outstanding items).
- [x] Per-project-type compliance policy editor on the Settings page (`GET/PUT
  /api/v1/compliance-policies`): set min coverage / max drift / required-mapped kinds from the
  UI instead of the API only.
- [x] Guard the vendored styleguide catalog against drift: `packages/cli/src/styleguideCatalog.ts`
  is a deliberate mirror of the `@specregistry/shared` catalog (vendored so the published CLI has
  no `@specregistry/shared` runtime dep). A mirror comment marks it and `styleguideCatalog.test.ts`
  asserts the two stay identical. (Full de-dup into one runtime source is still possible later.)
- [x] Scope agent-session listing: the agent-tier `GET /ai/agent-sessions` now requires a `repo`
  (no cross-repo enumeration of task text/plans/models); the global cross-repo view moved to the
  admin-gated `GET /api/v1/agent-sessions`.

## Validation & Dogfooding

The system is feature-rich but lightly battle-tested; every real signal so far has come from
actually running it, not from the backlog. Before adding more horizontal features, exercise the
whole loop end-to-end on a real project and let the friction re-rank everything below.

- [ ] **Dogfood: build a real small app end-to-end in secured mode.** Stand up the server with
  `SPECREG_AUTH=required` + a real admin password, run `specreg init` in a fresh repo (agent
  enrolls its own scoped token), let an agent do `begin_task` → write code → pull guidance via
  `resolve_guidance` → `specreg comply`/`finish_task` loop → submit a change → human approves in
  the UI. Capture every point of friction, 401, confusing message, or governance gap as a
  finding. Expected to surface the next round of real work (as the game experiment did:
  auth hole, self-approval, compliance-loop need).
- [ ] Operability pass uncovered while dogfooding: CI `npm rebuild better-sqlite3` (native ABI
  mismatch across Node versions broke the suite once), bound the code-trace ingest payload, and
  encrypt-at-rest the LDAP bind password and webhook/Slack secrets currently stored plaintext in
  settings.

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
- [x] Server ingestion for `specreg code-map --report`, persisted code trace reports, and
  project-level Reports UI coverage/drift summaries.
- [x] CI traceability enforcement and PR annotations via `specreg trace-check` plus the
  bundled GitHub Action's optional code trace gate.

Remaining AST/code metadata work:

- [ ] Manual traceability override workflow to approve, reject, or intentionally waive
  automatic code-to-spec links and route unmapped entities to new spec work.
- [ ] Deepen the traceability system with manual override review, deleted-entity retention,
  split/merge history, richer dependency graphs, and additional language parsers.

## Enterprise

- Secrets hygiene with encrypted-at-rest LDAP bind passwords and webhook secrets.
- GitHub App integration instead of raw `GITHUB_TOKEN`.
- Read-only public share links for approved spec bundles.
- SCIM or scheduled LDAP user/group sync.
