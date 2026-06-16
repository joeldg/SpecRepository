# SpecRegistry

Centralized management, versioning, and distribution of Markdown project specification
files (`DESIGN.md`, `STRUCTURE.md`, `API.md`, …) — "Avro for human and AI-readable text."
Humans manage specs through a web dashboard with a review workflow; developers pull
approved specs with the `specreg` CLI; AI agents read specs and report ambiguities
through a dedicated feedback endpoint.

The full product specification lives in [docs/SPEC.md](docs/SPEC.md). The operating model
for Spec Driven Development, observability, and token economics lives in
[docs/SDD_TOKENOMICS.md](docs/SDD_TOKENOMICS.md).

## Layout

| Package | Purpose |
| --- | --- |
| `packages/server` | Fastify API + SQLite storage, review workflow, signed bundles, AI feedback/draft-fix/audit/efficacy, FTS5 search, webhooks, analytics, auth + LDAP, git push-back, inbound git sync, Slack/GChat |
| `packages/web` | React management dashboard (specs, diffs, reviews, feedback, templates, settings, search, analytics, login, efficacy) |
| `packages/cli` | `specreg` developer CLI (`init`, `generate`, `check`, `sync`, `compile`, `verify`, `audit`) |
| `packages/mcp` | `specreg-mcp` — MCP stdio server so AI agents read specs / search / file feedback natively |
| `packages/shared` | Shared TypeScript domain types + semver/range helpers |
| `samples/ai-sdd` | Loadable sample spec pack + API loader (`npm run sample:ai-sdd`) |

## Install and Run

SpecRegistry can be run three ways:

- **Local development** — server and Vite web UI in separate processes.
- **Production-style Node** — built server serves both the API and built web UI.
- **Docker Compose** — containerized app with persistent SQLite storage and optional Grafana Alloy.

Prerequisites:

- Node.js 20+
- npm
- Docker + Docker Compose, only for container deployments

### Local development

```sh
npm install
cp .env.example .env
npm run build

# Development: API on :4000 (auto-seeds Acme demo data on first run)
npm run dev:server
# In another terminal: web UI on :5173, proxying /api to :4000
npm run dev:web
```

Open the dashboard at `http://localhost:5173`. API calls are proxied to
`http://localhost:4000`.

The development server seeds Acme demo data into `specregistry.db` the first time it
starts. Delete that file if you want a fresh local registry.

The server loads `.env` automatically for local `npm run dev:server`,
`npm run seed`, and `node packages/server/dist/index.js` runs. Real process
environment variables take precedence over values in `.env`.

### Production-style Node

Production-style: after `npm run build`, `node packages/server/dist/index.js` serves
both the API and the built web UI on port 4000 (`PORT` / `SPECREG_DB` env vars override
the defaults; the SQLite file defaults to `./specregistry.db`). Values can also be placed
in `.env` at the repository root.

```sh
npm install
npm run build
PORT=4000 SPECREG_DB=/var/lib/specregistry/specregistry.db node packages/server/dist/index.js
```

For a server install, set `SPECREG_PUBLIC_URL` to the externally reachable URL. Generated
agent packs, MCP guides, and `.mcp.json` examples use that value.

```sh
SPECREG_PUBLIC_URL=https://specs.example.com node packages/server/dist/index.js
```

### Validate the Build

```sh
npm test   # server API suite (vitest)
```

## Docker Install

For a containerized registry:

```sh
cp .env.example .env
# edit SPECREG_PUBLIC_URL to the URL agents/developers can reach
docker compose up --build
```

`SPECREG_PUBLIC_URL` is important for server deployments. Agent packs and MCP guide
content use it when generating `.mcp.json` and `SPECREGISTRY_MCP_SKILL.md`. If omitted,
the server falls back to forwarded request headers and then `http://localhost:4000`.
Persisted SQLite data lives in the `specregistry-data` Docker volume by default.

Example `.env` for an internal server:

```dotenv
PORT=4000
SPECREG_PUBLIC_URL=https://specs.example.com
SPECREG_AUTH=required
SPECREG_ADMIN_PASSWORD=change-this
SPECREG_DB=/data/specregistry.db
```

Run it:

```sh
docker compose up --build -d
docker compose logs -f specregistry
```

Stop it:

```sh
docker compose down
```

Reset local container data:

```sh
docker compose down -v
```

### Metrics and Grafana Alloy

SpecRegistry exposes Prometheus text metrics at `GET /metrics`. The endpoint is public
so Prometheus/Grafana Alloy can scrape it even when `SPECREG_AUTH=required`.

Run the registry only:

```sh
docker compose up --build
```

Run with Grafana Alloy scraping `/metrics` and remote-writing upstream:

```sh
GRAFANA_REMOTE_WRITE_URL=https://prometheus-prod-xx.grafana.net/api/prom/push \
GRAFANA_REMOTE_WRITE_USERNAME=<instance-id> \
GRAFANA_REMOTE_WRITE_PASSWORD=<api-token> \
docker compose --profile metrics up --build
```

The Alloy service reads [config/alloy/config.alloy](config/alloy/config.alloy), scrapes
`specregistry:4000/metrics`, and forwards samples to the configured remote-write endpoint.

## First-Time Setup

1. Start the server by using the local, Node, or Docker path above.
2. Open the dashboard.
3. If `SPECREG_AUTH=required`, sign in as `admin` with `SPECREG_ADMIN_PASSWORD`.
4. Create or edit project types. Use one global project type for organization-wide specs.
5. Add spec files such as `DESIGN.md`, `STRUCTURE.md`, `API.md`, or domain-specific docs.
6. Publish initial drafts once they are ready to become governed contracts.
7. Configure templates, approval policies, subscriptions, LDAP, and integrations as needed.
8. Install or link the CLI as shown in [Developer CLI](#developer-cli), then have each
   repository initialize its approved specs and agent MCP config.

## Usage Examples

### Admin Dashboard

Use the web dashboard to manage the registry:

- Create project types and organization-wide global specs.
- Edit drafts and publish initial versions.
- Submit, review, approve, reject, and promote change requests.
- Triage AI feedback clusters.
- Configure templates, webhooks, repo subscriptions, approval policies, users, API keys, and LDAP.
- Inspect usage analytics, review SLA risk, audit log entries, efficacy runs, and SDD metrics.

Typical local URLs:

```text
Development UI: http://localhost:5173
API and production UI: http://localhost:4000
Metrics: http://localhost:4000/metrics
```

### Developer CLI

Build the workspace before using the CLI. During local development, link the CLI and MCP
bins onto your PATH:

```sh
npm install
npm run build
npm link -w @specregistry/cli -w @specregistry/mcp
```

If you do not want to link the bins, run the built CLI directly from this checkout:

```sh
node packages/cli/dist/index.js --help
```

Initialize a repository with the approved spec bundle for a project type after the CLI is
built and either linked or called through `node packages/cli/dist/index.js`:

```sh
cd /path/to/app
specreg init --server http://localhost:4000 --type "Acme Edge Device"
```

Equivalent unlinked form:

```sh
node /path/to/SDDManager/packages/cli/dist/index.js init --server http://localhost:4000 --type "Acme Edge Device"
```

For an auth-required registry, pass a login/API token with `--token` or `SPECREG_TOKEN`:

```sh
SPECREG_TOKEN=sreg_... specreg init --server https://specs.example.com --type "Acme Edge Device"
specreg check --server https://specs.example.com --token sreg_...
```

That writes:

- `specs/*.md` — governed global + project-type specs.
- `specs/.specregistry.json` — versions, hashes, and bundle signature metadata.
- `.mcp.json` — MCP server config for AI agents in that repository.
- `SPECREGISTRY.md` — root-level guidance that tells humans and agents which manifest,
  specs directory, registry URL, project type, and MCP flow govern the repository.

`specreg init` and `specreg sync` protect governed files: if a local spec has been edited
or was not previously managed by the manifest, the CLI refuses to overwrite it unless
`--force` is passed. Repo-specific generated drafts should stay outside `specs/` until
they are submitted through the registry review workflow.

Generate repo-specific draft specs from local code into `.spec/drafts`, then submit them:

```sh
specreg generate --write --server https://specs.example.com --type "Acme Edge Device"
specreg submit-drafts --server https://specs.example.com --type "Acme Edge Device" --author alice
```

`submit-drafts` creates new registry drafts for filenames that do not exist yet. For
published specs with matching filenames, it opens normal change requests. Add `--publish`
to immediately publish newly-created registry drafts as `1.0.0`; existing published specs
still go through review.

Check for drift in CI:

```sh
specreg check --server https://specs.example.com
```

Synchronize when the registry has newer approved specs:

```sh
specreg sync --server https://specs.example.com
```

`specreg init`, `specreg check`, and `specreg sync` report the local manifest back to the
registry. The Settings page shows these repo consumers so admins can see which repositories
are using which project type, manifest path, spec count, and outdated spec count.

Compile governed specs into agent context files:

```sh
specreg compile --server https://specs.example.com --type "Web App Standard" --target claude
specreg compile --server https://specs.example.com --type "Web App Standard" --target agents
specreg compile --server https://specs.example.com --type "Web App Standard" --target cursor
```

Verify downloaded bundles offline against the registry public key:

```sh
specreg verify --server https://specs.example.com
```

Run an AI conformance audit:

```sh
specreg audit --server https://specs.example.com --type "Web App Standard" --ci
```

Every CLI command accepts `--token <token>` and also reads `SPECREG_TOKEN`. Use an
`agent` or `author` API key for repository automation, depending on which server routes
the workflow needs.

### AI Agent and MCP Usage

After `specreg init`, MCP-capable agents can use the generated `.mcp.json`:

```json
{
  "mcpServers": {
    "specregistry": {
      "command": "specreg-mcp",
      "args": [],
      "env": {
        "SPECREG_SERVER": "https://specs.example.com",
        "SPECREG_PROJECT_TYPE": "Web App Standard",
        "SPECREG_TOKEN": "sreg_..."
      }
    }
  }
}
```

`specreg init` includes `SPECREG_TOKEN` in the generated `.mcp.json` when the token is
present in the environment or passed with `--token`.

The MCP server exposes these tools:

- `list_project_types` — discover registry project types.
- `get_specs` — fetch governed global + project-type specs.
- `search_specs` — retrieve matching spec sections without loading everything.
- `report_spec_feedback` — file ambiguity, contradiction, or outdated-guidance feedback.

Direct agent endpoints are also available:

```sh
curl http://localhost:4000/api/v1/ai/specs/Web%20App%20Standard
curl "http://localhost:4000/api/v1/ai/search?q=authentication&project_type=Web%20App%20Standard"
curl http://localhost:4000/api/v1/ai/mcp-guide/Web%20App%20Standard
curl -o agent-pack.zip http://localhost:4000/api/v1/specs/Web%20App%20Standard/agent-pack
```

Agents should read specs before implementation, search when they need narrower guidance,
cite returned section permalinks when reporting findings, and report feedback instead of
guessing when a spec is ambiguous, contradictory, or stale.

### API Usage

List project types:

```sh
curl http://localhost:4000/api/v1/project-types
```

Create a draft spec:

```sh
curl -X POST http://localhost:4000/api/v1/specs \
  -H "content-type: application/json" \
  -d '{
    "project_type_id": "PROJECT_TYPE_ID",
    "filename": "API.md",
    "content": "# API\n\nContract goes here.",
    "updated_by": "alice"
  }'
```

Submit a governed change request:

```sh
curl -X POST http://localhost:4000/api/v1/specs/review \
  -H "content-type: application/json" \
  -d '{
    "spec_id": "SPEC_ID",
    "proposed_content": "# API\n\nUpdated contract.",
    "version_delta": "minor",
    "proposed_by": "alice",
    "summary": "Add integration contract"
  }'
```

Approve a review:

```sh
curl -X POST http://localhost:4000/api/v1/reviews/CHANGE_REQUEST_ID/approve \
  -H "content-type: application/json" \
  -d '{"reviewed_by":"reviewer-1"}'
```

When auth is required, sign in and pass the token:

```sh
TOKEN=$(
  curl -s -X POST http://localhost:4000/api/v1/auth/login \
    -H "content-type: application/json" \
    -d '{"username":"admin","password":"change-this"}' |
    node -e "let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => console.log(JSON.parse(s).token));"
)

curl http://localhost:4000/api/v1/auth/me -H "authorization: Bearer $TOKEN"
```

Create a long-lived API key for CLI, CI, or MCP automation:

```sh
curl -X POST http://localhost:4000/api/v1/auth/users \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"username":"agent-bot","role":"agent"}'

curl -X POST http://localhost:4000/api/v1/auth/api-keys \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"username":"agent-bot","name":"repo automation"}'
```

### CI Usage

Use `specreg check` as a drift gate:

```yaml
name: spec-drift
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm run build
      - run: node packages/cli/dist/index.js check --server https://specs.example.com
```

Use `specreg audit --ci` when you want LLM-backed implementation conformance checks.
That requires a server LLM provider configured through Settings or environment variables.

### Sample Data

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

### Observability Usage

Scrape Prometheus metrics:

```sh
curl http://localhost:4000/metrics
```

Useful metrics include:

- `specregistry_specs_total`
- `specregistry_reviews_total`
- `specregistry_oldest_pending_review_age_seconds`
- `specregistry_feedback_total`
- `specregistry_usage_events_total`
- `specregistry_audit_events_total`
- `specregistry_efficacy_runs_total`

Run Grafana Alloy through Compose:

```sh
docker compose --profile metrics up --build
```

### Integration Usage

Use webhooks and chat integrations to push SDD events into the places teams already work:

- JSON webhooks for publish, review, and feedback events.
- Slack-formatted webhooks for review visibility.
- Slack interactive approve/reject actions with a Slack signing secret.
- Google Chat-formatted webhook payloads.
- GitHub repo subscriptions that open pull requests when approved specs change.
- HMAC-verified inbound GitHub push webhooks that convert repo-side spec edits into reviews.

GitHub and Slack app keys can be configured on the Settings page or with environment variables.
Saved values are never returned to the browser; Settings only shows whether each key is present.

### Authentication, Roles, and LDAP Usage

Auth is off by default for a zero-config local experience. Enable it for shared servers:

```dotenv
SPECREG_AUTH=required
SPECREG_ADMIN_PASSWORD=change-this
```

Roles are `admin`, `reviewer`, `author`, and `agent`. Admins manage settings, reviewers
approve governed changes, authors create drafts and change requests, and agents can be
given scoped API keys for automation.

For LDAP, configure the Settings page or environment variables such as:

```dotenv
LDAP_URL=ldaps://ldap.example.com
LDAP_BIND_DN_TEMPLATE=uid={{username}},ou=people,dc=example,dc=com
LDAP_ADMIN_GROUP=SpecRegistry Admins
LDAP_REVIEWER_GROUP=SpecRegistry Reviewers
LDAP_DEFAULT_ROLE=author
```

Use the LDAP tester in Settings before switching users over.

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
  feedback item, **Draft AI fix** sends the spec + complaint to the configured server LLM
  and opens the revision as a normal
  pending change request — the review workflow stays the safety gate.
- **Templates & conformance lint** — per-filename templates define required sections;
  every change request is linted against them and new drafts scaffold from the
  template body. Lint results and a heading-based **compatibility report** (removed
  sections ⇒ major, added ⇒ minor) are stored on the change request and shown in review.
- **Contradiction checks** — change requests also store a deterministic cross-spec
  contradiction report. Proposed normative statements are compared with published global
  and project-type specs so reviewers can see possible conflicts before approval.
- **Distribution** — `specreg check` gates CI on spec drift; repo subscriptions open
  GitHub PRs with updated specs on approval (configure a GitHub token in Settings or set `GITHUB_TOKEN`);
  webhooks (JSON or Slack format) fire on publish/review/feedback events.
- **Search & analytics** — `GET /api/v1/ai/search?q=` serves section-level FTS5 hits
  to agents and the Search page; usage events (pulls, agent reads, searches, drift
  checks) roll up on the dashboard, including stale-but-published spec detection.
  Search and agent spec responses include stable section anchors/permalinks for exact citations.
- **Review SLA** — `GET /api/v1/reviews/sla` summarizes pending review age, warnings,
  breached reviews, and remaining approvals. The dashboard surfaces the oldest pending
  review and breached/warning counts.
- **Prometheus metrics** — `GET /metrics` exposes SDD and runtime governance metrics
  including spec counts, review states, feedback, usage events, sync jobs, users,
  approval policies, audit events, and efficacy runs. Docker Compose includes an
  optional Grafana Alloy profile for remote write.
- **Spec compiler** — `GET /api/v1/specs/:type/compile?target=claude|agents|cursor`
  renders the governed global + type spec set into the file agents actually load
  (`CLAUDE.md` / `AGENTS.md` / `.cursorrules`). `specreg sync` regenerates any target
  the repo has compiled, so the registry is the single source that produces agent context.
- **Agent onboarding packs** — `GET /api/v1/specs/:type/agent-pack` returns a zip with
  `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.mcp.json`, and `SPECREGISTRY_MCP_SKILL.md`.
  `GET /api/v1/ai/mcp-guide/:type` exposes the MCP skill guide directly for agent setup.
- **Repo consumers** — local manifests reported by `specreg init`, `specreg check`, and
  `specreg sync` let the Settings page show which repositories are using which spec set
  and how many reported specs are behind the latest approved versions.
- **Reverse conformance audit** — `POST /api/v1/ai/audit` (and `specreg audit`) asks
  the configured server LLM whether a codebase snapshot *follows* its governed specs,
  reporting violations with spec/section/file citations. Checks adherence, not just spec currency.
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
GET  /api/v1/reviews/sla
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
GET/PUT /api/v1/llm/config             POST /api/v1/llm/test
POST /api/v1/integrations/github/webhook   POST /api/v1/integrations/slack/actions
GET  /metrics
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
| `SPECREG_PUBLIC_URL` | Externally reachable URL used in agent packs and MCP guides |
| `SPECREG_AUTH=required` | Require auth on all non-public routes |
| `SPECREG_ADMIN_PASSWORD` | Seeded admin password (default `admin`) |
| `ANTHROPIC_API_KEY` | Anthropic key fallback for server LLM features |
| `OPENAI_API_KEY` | OpenAI key fallback for server LLM features |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini key fallback for server LLM features |
| `LLM_PROVIDER` | Server LLM provider: `anthropic`, `openai`, `gemini`, or `openai_compatible` |
| `LLM_MODEL` | Server LLM model name |
| `LLM_BASE_URL` | Anthropic proxy or OpenAI-compatible local/network endpoint |
| `LLM_API_KEY` | Server LLM API key; optional for some local endpoints |
| `LLM_MAX_TOKENS` | Default server LLM token budget |
| `GITHUB_TOKEN` | Git push-back PRs + inbound webhook file fetch; fallback if not saved in Settings |
| `GITHUB_WEBHOOK_SECRET` | Verify inbound GitHub push webhooks; fallback if not saved in Settings |
| `SLACK_SIGNING_SECRET` | Verify Slack interactive approve/reject actions; fallback if not saved in Settings |
| `LDAP_URL` (+ `LDAP_*`) | Optional LDAP authentication |

### Client environment variables

| Variable | Used by |
| --- | --- |
| `SPECREG_SERVER` | CLI, MCP, and sample loader registry URL |
| `SPECREG_TOKEN` | CLI, MCP, and sample loader Bearer/API token for auth-required registries |
| `SPECREG_PROJECT_TYPE` | MCP default project type |
| `SPECREG_GENERATE_PROVIDER` | CLI `specreg generate --write` provider: `anthropic`, `openai`, `gemini`, or `openai_compatible` |
| `SPECREG_GENERATE_MODEL` | CLI generation model override |
| `SPECREG_GENERATE_BASE_URL` | CLI generation base URL for proxy/local/OpenAI-compatible endpoints |
| `SPECREG_GENERATE_API_KEY` | CLI generation API key override |
| `SPECREG_GENERATE_MAX_TOKENS` | CLI generation token budget |

`specreg generate --write` also reads `.env` in the current directory. If
`SPECREG_GENERATE_*` variables are omitted, it falls back to the matching server-style
`LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY`, and provider API key variables
such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY`.

CLI generation examples:

```dotenv
SPECREG_GENERATE_PROVIDER=openai
SPECREG_GENERATE_MODEL=gpt-4.1
OPENAI_API_KEY=sk-...
```

```dotenv
SPECREG_GENERATE_PROVIDER=gemini
SPECREG_GENERATE_MODEL=gemini-3.5-flash
GEMINI_API_KEY=...
```

```dotenv
SPECREG_GENERATE_PROVIDER=openai_compatible
SPECREG_GENERATE_MODEL=llama3.1
SPECREG_GENERATE_BASE_URL=http://localhost:11434/v1
```

### Server LLM providers

Server-side LLM features include AI draft-fix, reverse conformance audit, and spec efficacy
tests. Configure them on the Settings page or with environment variables.

Anthropic example:

```dotenv
LLM_PROVIDER=anthropic
LLM_MODEL=claude-opus-4-8
ANTHROPIC_API_KEY=sk-ant-...
```

OpenAI example:

```dotenv
LLM_PROVIDER=openai
LLM_MODEL=gpt-4.1
OPENAI_API_KEY=sk-...
```

Gemini example:

```dotenv
LLM_PROVIDER=gemini
LLM_MODEL=gemini-3.5-flash
GEMINI_API_KEY=...
```

Local or network OpenAI-compatible example:

```dotenv
LLM_PROVIDER=openai_compatible
LLM_MODEL=llama3.1
LLM_BASE_URL=http://ollama.internal:11434/v1
LLM_API_KEY=
```

From Docker Compose on macOS/Windows, use `host.docker.internal` to reach a model server
running on the host:

```dotenv
LLM_PROVIDER=openai_compatible
LLM_MODEL=llama3.1
LLM_BASE_URL=http://host.docker.internal:11434/v1
```

OpenAI-compatible mode works with services such as Ollama, LM Studio, vLLM, LocalAI, or an
internal gateway that exposes `/chat/completions`.
The Settings page can query available models from Anthropic, OpenAI, Gemini, and
OpenAI-compatible providers that expose `/models`.

Spec download bundles are ed25519-signed; the keypair is generated on first use and stored
in the database. `specreg verify` checks bundle provenance against the public key.
