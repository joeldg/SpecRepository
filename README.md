# SpecRegistry

Centralized management, versioning, and distribution of Markdown project specification
files (`DESIGN.md`, `STRUCTURE.md`, `API.md`, …) — "Avro for human and AI-readable text."
Humans manage specs through a web dashboard with a review workflow; developers pull
approved specs with the `specreg` CLI; AI agents read specs and report ambiguities
through a dedicated feedback endpoint.

The full product specification lives in [docs/SPEC.md](docs/SPEC.md).

## Layout

| Package | Purpose |
| --- | --- |
| `packages/server` | Fastify API + SQLite storage, review workflow, signed bundles, AI feedback/draft-fix/audit/efficacy, FTS5 search, webhooks, analytics, auth + LDAP, git push-back, inbound git sync, Slack/GChat |
| `packages/web` | React management dashboard (specs, diffs, reviews, feedback, templates, settings, search, analytics, login, efficacy) |
| `packages/cli` | `specreg` developer CLI (`init`, `generate`, `check`, `sync`, `compile`, `verify`, `audit`) |
| `packages/mcp` | `specreg-mcp` — MCP stdio server so AI agents read specs / search / file feedback natively |
| `packages/shared` | Shared TypeScript domain types + semver/range helpers |
| `samples/ai-sdd` | Loadable sample spec pack + API loader (`npm run sample:ai-sdd`) |

## Quick start

```sh
npm install
npm run build

# Development: API on :4000 (auto-seeds Acme demo data on first run)
npm run dev:server
# In another terminal: web UI on :5173, proxying /api to :4000
npm run dev:web
```

Production-style: after `npm run build`, `node packages/server/dist/index.js` serves
both the API and the built web UI on port 4000 (`PORT` / `SPECREG_DB` env vars override
the defaults; the SQLite file defaults to `./specregistry.db`).

```sh
npm test   # server API suite (vitest)
```

## Sample data

Beyond the built-in Acme demo seed, an **AI-SDD sample spec pack** populates a running
registry with realistic content — 6 org-wide process specs (agent operating rules, git flow,
code standards, documentation, observability, ticket workflow) plus an *Embedded Systems
Platform* project type with 8 technical contract specs (system, API, SNMP, UDP, protobuf,
config, DB schema, test strategy):

```sh
npm run sample:ai-sdd            # loads via the API into the server on :4000
# or target/authenticate explicitly:
SPECREG_SERVER=http://localhost:4000 SPECREG_TOKEN=sreg_... node samples/ai-sdd/load.mjs
```

The loader is idempotent (publishes each spec as 1.0.0, skips anything already present). See
[samples/ai-sdd/README.md](samples/ai-sdd/README.md) for the full contents.

## CLI

```sh
# New project: pick a project type interactively, pull approved specs into ./specs/
# Also drops a .mcp.json so MCP-capable agents in the repo use the registry natively.
node packages/cli/dist/index.js init

# Existing project: scan the codebase, fetch tailored LLM prompts into .spec/prompts/
node packages/cli/dist/index.js generate

# Drift detection: compare local specs/.specregistry.json to the registry.
node packages/cli/dist/index.js check   # exit 1 on drift — wire into CI
node packages/cli/dist/index.js sync    # re-pull approved specs when drifted

# Compile the governed spec set into an agent context file.
node packages/cli/dist/index.js compile --target claude   # or agents | cursor

# Verify local spec hashes + the registry's ed25519 bundle signature.
node packages/cli/dist/index.js verify

# Ask Claude whether this codebase violates its governed specs (needs server ANTHROPIC_API_KEY).
node packages/cli/dist/index.js audit --ci   # exit 1 when findings exist

# Flags: --server <url> (or $SPECREG_SERVER), --type <name> to skip the prompt,
#        --dir (spec directory), --out (generate output), --target, --force, --ci
```

`npm link -w @specregistry/cli -w @specregistry/mcp` installs `specreg` and `specreg-mcp` onto your PATH.

## MCP server

`specreg-mcp` is a stdio MCP server exposing `list_project_types`, `get_specs`,
`search_specs`, and `report_spec_feedback`. `specreg init` writes a ready-to-use
`.mcp.json` (configured via `SPECREG_SERVER` / `SPECREG_PROJECT_TYPE` env vars), so
Claude Code and other MCP clients in that repo consult governed specs and file
feedback without raw HTTP.

## Concepts

- **Hierarchy** — project types are rows, not code. A seeded `scope=global` type holds
  organization-wide specs; every download/agent query bundles global + type specs.
  The Acme types are just seed data (`packages/server/src/seed.ts`).
- **Lifecycle** — new specs start as `0.1.0` drafts and are edited directly. Publishing
  makes them `1.0.0`. Published specs only change through a change request
  (`POST /api/v1/specs/review`): the server stores a unified diff, the spec enters
  `pending_review`, and approval bumps the semver by the requested delta
  (major/minor/patch) and records an immutable version snapshot.
- **AI feedback loop** — agents read `GET /api/v1/ai/specs/:projectType` and report
  spec ambiguities/contradictions to `POST /api/v1/ai/feedback`, which appear as
  alerts on the dashboard and on the affected spec until triaged. Repeated complaints
  are clustered by spec/type/text at `GET /api/v1/ai/feedback/clusters`. From any
  feedback item, **Draft AI fix** sends the spec + complaint to Claude (`claude-opus-4-8`,
  requires `ANTHROPIC_API_KEY` on the server) and opens the revision as a normal
  pending change request — the review workflow stays the safety gate.
- **Templates & conformance lint** — per-filename templates define required sections;
  every change request is linted against them and new drafts scaffold from the
  template body. Lint results and a heading-based **compatibility report** (removed
  sections ⇒ major, added ⇒ minor) are stored on the change request and shown in review.
- **Distribution** — `specreg check` gates CI on spec drift; repo subscriptions open
  GitHub PRs with updated specs on approval (set `GITHUB_TOKEN` on the server);
  webhooks (JSON or Slack format) fire on publish/review/feedback events.
- **Search & analytics** — `GET /api/v1/ai/search?q=` serves section-level FTS5 hits
  to agents and the Search page; usage events (pulls, agent reads, searches, drift
  checks) roll up on the dashboard, including stale-but-published spec detection.
- **Spec compiler** — `GET /api/v1/specs/:type/compile?target=claude|agents|cursor`
  renders the governed global + type spec set into the file agents actually load
  (`CLAUDE.md` / `AGENTS.md` / `.cursorrules`). `specreg sync` regenerates any target
  the repo has compiled, so the registry is the single source that produces agent context.
- **Agent onboarding packs** — `GET /api/v1/specs/:type/agent-pack` returns a zip with
  `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.mcp.json`, and `SPECREGISTRY_MCP_SKILL.md`.
  `GET /api/v1/ai/mcp-guide/:type` exposes the MCP skill guide directly for agent setup.
- **Reverse conformance audit** — `POST /api/v1/ai/audit` (and `specreg audit`) asks
  Claude whether a codebase snapshot *follows* its governed specs, reporting violations
  with spec/section/file citations. Checks adherence, not just spec currency.
- **Spec efficacy testing** — `POST /api/v1/ai/efficacy` runs a task with and without
  the spec in context and grades both, measuring whether a spec actually changes agent
  output ("earns its tokens" vs "no lift").
- **Auth, roles & review routing** — local accounts (scrypt) or optional LDAP; roles
  (admin/reviewer/author/agent) gate approvals and settings; per-project-type required
  reviewers (CODEOWNERS-style). Approval policies can require multiple reviewers by
  project type and filename glob. Bearer tokens / `x-api-key` for agents and CI.
- **Audit log** — governance-sensitive actions (login, user/API-key changes, LDAP/settings
  changes, review submission/approval/rejection/publish, templates, webhooks, subscriptions,
  and sync-job runs) are recorded in `audit_log` and surfaced at `GET /api/v1/audit-log`.
- **Channels & semver ranges** — approve to a `beta` channel without touching the stable
  head, then promote; manifests can carry caret pins (`^1.0.0`) and `sync-check` reports
  drift severity and whether the latest is within the pin.
- **Signed bundles** — download manifests carry per-file SHA-256 and an ed25519 signature;
  `specreg verify` checks provenance offline against `/api/v1/meta/public-key`.
- **Two-way git sync** — a subscribed repo editing `specs/*.md` (HMAC-verified GitHub push
  webhook) auto-opens a matching change request, closing the last drift hole.
- **Chat integrations** — webhooks in JSON, **Slack** (with interactive approve/reject
  buttons → `/api/v1/integrations/slack/actions`), or **Google Chat** format.

## API surface (v1)

```
GET  /api/v1/project-types              POST /api/v1/project-types
GET  /api/v1/specs                      POST /api/v1/specs
GET  /api/v1/specs/:id                  PUT  /api/v1/specs/:id          (drafts only)
POST /api/v1/specs/:id/publish          GET  /api/v1/specs/:type/download   (zip)
POST /api/v1/specs/review               GET  /api/v1/reviews[?status=]
POST /api/v1/reviews/:id/approve        POST /api/v1/reviews/:id/reject
GET  /api/v1/ai/specs/:projectType      POST /api/v1/ai/feedback
GET  /api/v1/ai/feedback[?status=]      POST /api/v1/ai/feedback/:id/status
GET  /api/v1/ai/feedback/clusters       POST /api/v1/ai/feedback/:id/draft-fix
GET  /api/v1/ai/search?q=[&project_type=]  GET /api/v1/ai/mcp-guide/:type
POST /api/v1/ai/audit                   POST /api/v1/ai/efficacy
POST /api/v1/specs/:id/promote          GET  /api/v1/specs/:type/compile?target=
GET  /api/v1/specs/:type/agent-pack     GET/POST/DELETE /api/v1/approval-policies
GET  /api/v1/specs/:type/download[?channel=beta]   GET /api/v1/meta/public-key
POST /api/v1/cli/stub-prompts           POST /api/v1/cli/sync-check
GET/POST/PUT/DELETE /api/v1/templates   GET/POST/DELETE /api/v1/webhooks
GET/POST/DELETE /api/v1/subscriptions   GET /api/v1/sync-jobs · POST /api/v1/sync-jobs/run
GET  /api/v1/analytics/summary          POST /api/v1/auth/login · GET /api/v1/auth/me
GET/POST /api/v1/auth/users             GET/POST/DELETE /api/v1/auth/api-keys
GET/PUT /api/v1/ldap/config             POST /api/v1/ldap/test · POST /api/v1/ldap/role-preview
GET  /api/v1/audit-log
POST /api/v1/integrations/github/webhook   POST /api/v1/integrations/slack/actions
```

### Authentication & roles

Auth is **off by default** (anonymous access, free-text author names) for the zero-config
dev experience. Set `SPECREG_AUTH=required` to require a Bearer token / `x-api-key` on every
non-public route. A local `admin` account is seeded (password from `SPECREG_ADMIN_PASSWORD`,
default `admin`). Roles: `admin` > `reviewer` > `author` > `agent`; approvals need `reviewer`,
settings need `admin`. Per-project-type required reviewers restrict who can approve; approval
policies can also require N recorded approvals before a change publishes.

Set `LDAP_URL` to authenticate against a directory instead (direct-bind via
`LDAP_BIND_DN_TEMPLATE`, or service-account search via `LDAP_SEARCH_BASE`/`LDAP_SEARCH_FILTER`);
map roles with `LDAP_ADMIN_GROUP` / `LDAP_REVIEWER_GROUP`.

### Server environment variables

| Variable | Enables |
| --- | --- |
| `PORT`, `SPECREG_DB` | Listen port (4000) and SQLite path |
| `SPECREG_AUTH=required` | Require auth on all non-public routes |
| `SPECREG_ADMIN_PASSWORD` | Seeded admin password (default `admin`) |
| `ANTHROPIC_API_KEY` | AI draft-fix, audit, and efficacy |
| `GITHUB_TOKEN` | Git push-back PRs + inbound webhook file fetch |
| `GITHUB_WEBHOOK_SECRET` | Verify inbound GitHub push webhooks |
| `SLACK_SIGNING_SECRET` | Verify Slack interactive approve/reject actions |
| `LDAP_URL` (+ `LDAP_*`) | Optional LDAP authentication |

Spec download bundles are ed25519-signed; the keypair is generated on first use and stored
in the database. `specreg verify` checks bundle provenance against the public key.
