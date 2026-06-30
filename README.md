# SpecRegistry

SpecRegistry turns your project specifications into an AI-ready control plane. Instead of
hoping every agent, editor, prompt, and teammate remembers the same architecture rules,
SpecRegistry gives your specs versioning, review gates, signed distribution, MCP access,
drift checks, feedback loops, and observability. If you are building with AI, this is the
missing layer that keeps generated work aligned with what you actually intended: approved
Markdown specs (`DESIGN.md`, `STRUCTURE.md`, `API.md`, and more) become governed context
that humans can review, developers can sync, and agents can load before they touch code.

![SpecRegistry Dashboard](docs/pictures/dashboard.jpeg)

> [!NOTE]
> Read the core philosophy behind SpecRegistry in the Medium article: [AI Coding Agents Need a Control Plane, Not Better Prompts](https://medium.com/@joeldg/ai-coding-agents-need-a-control-plane-not-better-prompts-bfaa8bb06951).
> 
> *"When an agent can generate a multi-file implementation from a Markdown design document, the spec becomes the real source of intent. The code is an artifact. The spec is the control surface."*

The full product specification lives in [docs/SPEC.md](docs/SPEC.md). The operating model
for Spec Driven Development, observability, and token economics lives in
[docs/SDD_TOKENOMICS.md](docs/SDD_TOKENOMICS.md).

## Layout

| Package | Purpose |
| --- | --- |
| `packages/server` | Fastify API + SQLite storage, review workflow, signed bundles, AI feedback/draft-fix/audit/efficacy, FTS5 search, webhooks, analytics, auth + LDAP, git push-back, inbound git sync, Slack/GChat |
| `packages/web` | React management dashboard (specs, diffs, reviews, feedback, templates, settings, search, analytics, login, efficacy) |
| `packages/cli` | `specreg` developer CLI (`init`, `generate`, `code-map`, `check`, `sync`, `compile`, `verify`, `audit`, `mcp`) |
| `packages/mcp` | Legacy standalone `specreg-mcp` binary; generated configs prefer `specreg mcp` so the dashboard-downloaded CLI can run MCP directly |
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
For the full metric catalog and source queries, see
[README-METRICS.md](README-METRICS.md).

## First-Time Setup

1. Start the server by using the local, Node, or Docker path above.
2. Open the dashboard.
3. Sign in with the default admin account: **username `admin`, password `admin`**.
   Override the default password with `SPECREG_ADMIN_PASSWORD` in `.env` or the environment.
   Change the password after first login via **Settings → Users → Reset password**.
4. Create or edit project types. Use one global project type for organization-wide specs.
5. Add spec files such as `DESIGN.md`, `STRUCTURE.md`, `API.md`, or domain-specific docs.
6. Publish initial drafts once they are ready to become governed contracts.
7. Configure templates, compliance policies, approval policies, subscriptions, LDAP, and integrations as needed.
8. Install or link the CLI as shown in [Developer CLI](#developer-cli), then have each
   repository initialize its approved specs and agent MCP config.

## Usage Examples

### Admin Dashboard

Use the web dashboard to manage the registry:

- Create project types and organization-wide global specs.
- Edit drafts and publish initial versions.
- Submit, review, approve, reject, and promote change requests.
- Triage AI feedback clusters.
- Configure templates, webhooks, repo subscriptions, compliance policies, approval policies, users, API keys, and LDAP.
- Inspect usage analytics, review SLA risk, audit log entries, efficacy runs, and SDD metrics.

Typical local URLs:

```text
Development UI: http://localhost:5173
API and production UI: http://localhost:4000
Metrics: http://localhost:4000/metrics
```

## Project Quickstart

Use this flow when bringing SpecRegistry into a new or existing repository.

1. **Build and link the CLI.**
   From the SpecRegistry checkout, install dependencies, build the workspace, and link the
   local `specreg` binary onto your PATH. The CLI also exposes the MCP stdio server via
   `specreg mcp`, which is what generated `.mcp.json` files use:

   ```sh
   cd /path/to/SDDManager
   npm install
   npm run build
   npm link -w @specregistry/cli
   ```

   If you do not want to link the binaries, use
   `node /path/to/SDDManager/packages/cli/dist/index.js ...` anywhere this quickstart shows
   `specreg ...`.

2. **Choose the initialization path.**
   For a brand-new project, run the guided walkthrough. It records the intended product
   shape, languages, frameworks, platforms, databases, interfaces, servers/runtimes,
   infrastructure, identity, messaging, observability, testing, delivery, security,
   environments, constraints, and non-goals. For an existing standardized project, pass
   `--type` to use a premade project type directly.

3. **Initialize the repository.**
   From the project root, pull the approved spec bundle, write the local manifest, create
   MCP config, and optionally install suggested Google style guides:

   ```sh
   cd /path/to/app
   # New project: guided setup is the default
   specreg init --server http://localhost:4000

   # Existing/premade baseline: skip the walkthrough
   specreg init --server http://localhost:4000 --type "Acme Edge Device"
   ```

4. **Generate or edit repo-specific draft specs.**
   For an existing codebase, let the CLI scan the project and create draft material under
   `.spec/drafts/`. For a new project, write the specs you want to submit there directly.

   ```sh
   specreg generate --write --examples --server http://localhost:4000 --type "Acme Edge Device"
   ```

   `--examples` writes companion files like `.spec/examples/DESIGN.examples.md` with
   positive examples, anti-examples, edge cases, and review notes for the generated draft.

5. **Submit drafts to the registry.**
   This creates project-scoped drafts or review requests so they can become governed specs.
   Use `--publish` for newly-created drafts you want to publish immediately, and `--force`
   when you intentionally want to resubmit/overwrite local generated draft material.

   ```sh
   specreg submit-drafts --server http://localhost:4000 --type "Acme Edge Device" --publish --force
   ```

6. **Approve and publish reviews in the dashboard.**
   Open [http://localhost:5173/reviews](http://localhost:5173/reviews), inspect diffs,
   compatibility reports, lint findings, and risk notes, then approve/publish the reviews
   that should become governed source of truth.

7. **Pull the approved versions locally.**
   After the registry publishes the specs, sync the local `specs/` directory and manifest.

   ```sh
   specreg sync --server http://localhost:4000
   ```

8. **Compile agent context.**
   Rebuild `CLAUDE.md`, `AGENTS.md`, or `.cursorrules` from the approved local spec set.
   `specreg sync` also auto-compiles targets that were previously remembered.

   ```sh
   specreg compile --server http://localhost:4000 --target claude
   ```

### Developer CLI

Build the workspace before using the CLI. During local development, link the CLI onto your
PATH; `specreg mcp` runs the MCP stdio server:

```sh
npm install
npm run build
npm link -w @specregistry/cli
```

If you do not want to link the bins, run the built CLI directly from this checkout:

```sh
node packages/cli/dist/index.js --help
```

Initialize a new repository after the CLI is built and either linked or called through
`node packages/cli/dist/index.js`:

```sh
cd /path/to/app
specreg init --server http://localhost:4000
```

Interactive `specreg init` defaults to a comprehensive new-project walkthrough. Each
multi-choice step accepts comma-separated numbers, option names, or arbitrary custom text.
The walkthrough covers:

- project intent, lifecycle stage, users, product/application shapes
- languages, frameworks, libraries, target platforms, databases, and data stores
- APIs, protocols, servers, runtimes, packaging, cloud, and infrastructure
- authentication, authorization, messaging, and background processing
- observability, testing, CI/CD, release, security, privacy, and compliance
- deployment environments, architecture constraints, and explicit non-goals
- governed agent skills selected from the registry catalog

After the walkthrough, choose an existing/premade project type as the approved baseline or
create a reusable project type. The CLI downloads its governed specs, writes a structured
`.spec/project-profile.json`, creates `.spec/drafts/PROJECT_PROFILE.md`, reports the concrete
project to the registry, and submits the Markdown profile as a project-scoped draft. Review
and publish that draft in SpecRegistry before treating it as governed guidance.

The wizard also installs selected agent procedures under `.spec/skills/<slug>/SKILL.md` and
records them in `.spec/skills/manifest.json`. Press Enter to install the safe built-in set,
or select registered skills by number/slug. Restricted skills are visibly labeled and should
only be selected when their procedure is appropriate. A skill organizes instructions; it does
not grant an agent permission to perform destructive, privileged, or external actions.

For existing projects, scripts, and CI, `--type` keeps the direct premade flow and skips the
walkthrough:

```sh
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
- `.spec/project-profile.json` — structured answers from guided new-project setup (guided path only).
- `.spec/drafts/PROJECT_PROFILE.md` — reviewable project-scoped profile generated by the walkthrough (guided path only).
- `.spec/skills/*/SKILL.md` — selected governed agent operating procedures.
- `.spec/skills/manifest.json` — skill IDs, slugs, descriptions, and risk levels installed for the project.
- `.spec/styleguides/*.md` — selected Google style guides converted to Markdown.
- `.spec/styleguides/google-styleguides.json` — fetched guide manifest with source URLs.
- `.mcp.json` — MCP server config for AI agents in that repository.
- `AGENTS.md` — root-level bootstrap instructions that point first-run agents to
  `SPECREGISTRY.md`, `.mcp.json`, governed specs, and governed skills.
- `SPECREGISTRY.md` — root-level guidance that tells humans and agents which manifest,
  specs directory, registry URL, project type, and MCP flow govern the repository.

Generated `.mcp.json` runs the MCP server through the installed CLI:

```json
{
  "mcpServers": {
    "specregistry": {
      "command": "specreg",
      "args": ["mcp"]
    }
  }
}
```

That avoids requiring a separate `specreg-mcp` binary on every agent machine. If the
registry requires auth, `specreg init` carries `SPECREG_TOKEN` into `.mcp.json` when a token
is provided or enrolled.

During `specreg init`, the CLI scans the repository and suggests Google style guides from
[google.github.io/styleguide](https://google.github.io/styleguide/) for detected languages,
plus the documentation guide from `/docguide`. Press Enter to accept the suggested
multi-select, choose comma-separated numbers/IDs, or use flags for automation:

```sh
specreg init --styleguides suggested
specreg init --styleguides typescript,html-css,docguide
specreg init --styleguides none
specreg init --styleguides all --styleguide-dir docs/google-styleguides --force
```

Control agent skill installation for interactive or automated initialization:

```sh
specreg init --skills base
specreg init --skills load-governed-specs,plan-from-specs,verify-conformance
specreg init --skills all --skill-dir .agent/skills
specreg init --skills none
```

Admins register, disable, or delete custom skills in **Settings > AI & Search > Agent skills**.
Built-in skills can be disabled but not deleted. Catalog entries contain Markdown instructions,
a purpose description, and a `safe` or `restricted` risk label; executable payloads and secrets
do not belong in skills.

These Google guides are advisory external process inputs, not governed registry specs.
They are kept outside `specs/` so `specreg check` and `specreg sync` continue to verify only
the approved registry bundle. Re-run `specreg init --styleguides suggested --force` to
refresh the fetched copies. See [README-GOOGLE-STYLEGUIDES.md](README-GOOGLE-STYLEGUIDES.md)
for the guide catalog, selection rules, and SDD semantics.

`specreg init` and `specreg sync` protect governed files: if a local spec has been edited
or was not previously managed by the manifest, the CLI refuses to overwrite it unless
`--force` is passed. Repo-specific generated drafts should stay outside `specs/` until
they are submitted through the registry review workflow.

Generate repo-specific draft specs from local code into `.spec/drafts`, then submit them:

```sh
specreg generate --write --examples --server https://specs.example.com --type "Acme Edge Device"
specreg submit-drafts --server https://specs.example.com --type "Acme Edge Device" --author alice
```

Use `--examples` to save companion example templates under `.spec/examples/` during the
same generation pass. Override the location with `--example-dir <path>`. These files are
kept outside `.spec/drafts/` by default so `submit-drafts` does not submit local examples
unless reviewers intentionally fold them into a governed spec.

`submit-drafts` reports the current repo to the registry and creates project-scoped drafts
for that repo. If a generated filename already exists as a global or project-type spec, the
new draft becomes a repo-specific override instead of changing the shared baseline. If the
repo already has a published project-scoped spec with that filename, the CLI opens a normal
change request. Add `--publish` to immediately publish newly-created project drafts as
`1.0.0`; existing project-scoped published specs still go through review.

Check for drift in CI:

```sh
specreg check --server https://specs.example.com
```

`check` first verifies the signed local bundle: every governed file in `specs/`
must match the SHA-256 recorded in `specs/.specregistry.json`, and the manifest
signature must verify against the registry public key. It then asks the registry
whether newer approved versions exist. The command exits non-zero for local edits,
missing governed files, unsigned/invalid manifests, missing specs, or version drift.

Synchronize when the registry has newer approved specs:

```sh
specreg sync --server https://specs.example.com
```

If local governed specs were edited after download, plain `sync` refuses to discard
those edits. Use `specreg sync --force --server https://specs.example.com` only when
you intend to restore the approved registry bundle over local changes.

`specreg init`, `specreg check`, `specreg sync`, and `specreg submit-drafts` report the
local manifest back to the registry. The Settings page shows these projects so admins can
see which repositories are using which project type, manifest path, spec count, and outdated
spec count.

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

Generate code metadata sidecars for AST/code-to-spec work:

```sh
specreg code-map
specreg code-map --out .spec/code-map.json --force
specreg code-map --dir specs --trace-out .spec/code-trace.json
specreg code-map --report
specreg trace-check --min-coverage 70% --max-drift 25% --fail-on-unmapped route,schema,command
```

`code-map` writes `.spec/code-map.json` with stable code IDs, entity kinds, paths,
signatures, source locations, hashes, parent links, route metadata, coverage, and drift
summaries. It also writes `.spec/code-trace.json`, which links code entities to local
Markdown specs, reports unmapped implementation surfaces, records stable-ID aliases when
prior inventory data is available, and includes a code embedding profile for future
semantic matching. The extractor uses the TypeScript compiler for TypeScript/JavaScript
AST entities and lightweight Python/SQL/config extraction for imports, functions, classes,
routes, commands, config, migrations, tables, fields, and indexes. It does not rewrite
source files.

Use `specreg code-map --report` to upload the traceability report to the registry. The CLI
uses `--type` or the local `specs/.specregistry.json` manifest to identify the project type.
Uploaded reports appear on the Reports page as code-to-spec coverage, drift severity, and
unmapped implementation counts.

Use `specreg trace-check` in CI to fail on insufficient code-to-spec coverage, excessive
drift, or critical unmapped entity kinds. In GitHub Actions it emits native annotations
that point at unmapped files/lines from `.spec/code-trace.json`.

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
      "command": "specreg",
      "args": ["mcp"],
      "env": {
        "SPECREG_SERVER": "https://specs.example.com",
        "SPECREG_PROJECT_TYPE": "Web App Standard",
        "SPECREG_REPO": "github.com/acme/web-app",
        "SPECREG_TOKEN": "sreg_..."
      }
    }
  }
}
```

`specreg init` includes `SPECREG_TOKEN` in the generated `.mcp.json` when the token is
present in the environment or passed with `--token`.

The MCP server exposes these tools:

- `begin_task` — register an agent session, run preflight, and return the governed spec bundle to load.
- `finish_task` — record completion evidence, run objective compliance, and block completion until it passes.
- `list_project_types` — discover registry project types.
- `get_specs` — fetch governed global + project-type + project-scoped specs.
- `search_specs` — retrieve matching spec sections, including project-scoped matches, without loading everything.
- `resolve_guidance` — check whether a language or domain is governed before inventing a local standard.
- `check_compliance` — record and evaluate the objective compliance loop directly, useful for CI or ad hoc checks.
- `get_audit_prompt` — fetch a reverse-conformance audit prompt for a governed spec.
- `report_spec_feedback` — file ambiguity, contradiction, or outdated-guidance feedback.
- `report_guidance_gap` — file missing language/domain guidance when no existing spec applies.

For the full agent feedback loop, including compiled files, MCP tool usage, dashboard
triage, draft fixes, and release/sync behavior, see [README-AGENTS.md](README-AGENTS.md).

Direct agent endpoints are also available:

```sh
curl http://localhost:4000/api/v1/ai/specs/Web%20App%20Standard
curl "http://localhost:4000/api/v1/ai/specs/Web%20App%20Standard?repo=github.com/acme/web-app"
curl "http://localhost:4000/api/v1/ai/search?q=authentication&project_type=Web%20App%20Standard&repo=github.com/acme/web-app"
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
      - uses: joeldg/SpecRepository/.github/actions/specreg-check@main
        with:
          server: https://specs.example.com
          token: ${{ secrets.SPECREG_TOKEN }}
          dir: specs
          comment: "true"
          fail-on-drift: "true"
          trace-check: "true"
          min-coverage: "70%"
          max-drift: "25%"
          fail-on-unmapped: route,schema,command
```

The action builds the bundled CLI, runs `specreg check` against the checked-out
repository, posts or updates a PR comment with the drift output, and fails the workflow
when drift or local governed-spec modification is detected unless `fail-on-drift` is set
to `false`. When `trace-check` is enabled, it also runs `specreg code-map` and
`specreg trace-check`, producing PR annotations for unmapped critical code entities and
failing on the configured coverage/drift thresholds.

Use `specreg audit --ci` when you want LLM-backed implementation conformance checks.
That requires a server LLM provider configured through Settings or environment variables.

### Sample Data

Fresh databases seed a **SpecRegistry Operating Baseline** into the Global project type.
These are the always-available SDD process specs that teach agents and humans how to use
the registry correctly:

- `SDD_OPERATING_MODEL.md`
- `AGENT_OPERATING_RULES.md`
- `SPEC_AUTHORING_STANDARD.md`
- `SPEC_GOVERNANCE.md`
- `TRACEABILITY_AND_OBSERVABILITY.md`
- `TOKENOMICS.md`
- `IMPLEMENTATION_EVIDENCE.md`
- `SECURITY_AND_SECRETS.md`
- `PROJECT_PROFILE.md`

Each baseline spec includes Scope, Intent, Requirements, Non-Goals, Acceptance Evidence,
Token Budget Class, Related Specs, and AI Agent Directives. Existing databases receive
missing baseline specs idempotently on startup/seed.

Beyond the built-in baseline and Acme demo seed, an **AI-SDD sample spec pack** populates a running
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

See [README-METRICS.md](README-METRICS.md) for where and how each metric is generated.

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
  The built-in SpecRegistry Operating Baseline is the default global SDD process pack.
  The Acme types are demo seed data; additional built-in starter types include MCP Server
  / Agent Integration, SaaS Backend API, CLI Tool / Developer Tooling, AI-SDD Governed
  Project, Data Platform / ETL Pipeline, Internal Admin Tool, and Mobile App.
- **Lifecycle** — new specs start as `0.1.0` drafts and are edited directly. Publishing
  makes them `1.0.0`. Published specs only change through a change request
  (`POST /api/v1/specs/review`): the server stores a unified diff, the spec enters
  `pending_review`, and approval bumps the semver by the requested delta
  (major/minor/patch) and records an immutable version snapshot. Admins can soft-delete
  specs; deleted specs are hidden from governed reads, downloads, search, reports, and
  automation while being retained for 14 days. The filename stays reserved during
  retention so admins can restore the exact governed artifact without ambiguity.
- **AI feedback loop** — agents read `GET /api/v1/ai/specs/:projectType` and report
  spec ambiguities/contradictions to `POST /api/v1/ai/feedback`, which appear as
  alerts on the dashboard and on the affected spec until triaged. Repeated complaints
  are clustered by spec/type/text at `GET /api/v1/ai/feedback/clusters`; clusters can be
  acknowledged, resolved, or drafted as one change request. From any feedback item,
  **Draft AI fix** sends the spec + complaint to the configured server LLM and opens the revision as a normal
  pending change request — the review workflow stays the safety gate.
- **Templates & conformance lint** — per-filename templates define required sections;
  every change request is linted against them and new drafts scaffold from the
  template body. Lint also checks for missing examples, missing non-goals, missing
  operational sections, and ambiguity terms. Lint results and a heading-based
  **compatibility report** (removed sections ⇒ major, added ⇒ minor) are stored on
  the change request and shown in review.
- **Contradiction checks** — change requests also store a deterministic cross-spec
  contradiction report. Proposed normative statements are compared with published global
  and project-type specs so reviewers can see possible conflicts before approval.
- **Governance previews** — change requests carry a risk score for compatibility,
  security/privacy sensitivity, contradictions, and lint failures. Review detail includes
  a dry-run publish preview showing affected repos, generated agent files, webhooks, and
  sync jobs before approval. The preview also includes impact analysis: affected manifest
  consumers, subscribed repos, downstream spec references, open feedback, recent usage,
  and an impact score/level. It also generates a downstream migration checklist and
  PR-ready summary/changelog for spec update pull requests. Approval policies double as
  CODEOWNERS-style spec ownership and are exposed through `GET /api/v1/spec-ownership`.
- **Distribution** — `specreg check` gates CI on spec drift; repo subscriptions open
  GitHub PRs with updated specs on approval (configure a GitHub token in Settings or set `GITHUB_TOKEN`);
  webhooks (JSON or Slack format) fire on publish/review/feedback events.
- **Project-scoped specs** — repo projects are first-class consumers attached to a
  project type. Global specs define the shared baseline, project-type specs define the
  domain baseline, and project specs override only that repo when local behavior needs
  governed guidance without changing every consumer of the type.
- **Search & analytics** — `GET /api/v1/ai/search?q=&mode=fts|semantic|hybrid` serves
  section-level FTS5, embedding, or combined search hits to agents and the Search page;
  usage events (pulls, agent reads, searches, drift checks) roll up on the dashboard,
  including stale-but-published spec detection. Search and agent spec responses include
  stable section anchors/permalinks for exact citations.
- **Granular reports** — the Reports page and `GET /api/v1/reports/overview` break SDD
  health down by global specs, project types, and individual projects, with scope mix,
  feedback mix, review risk, stale specs, efficacy outcomes, and project drift counts.
  Reports also show dependency-map, token-ROI panels, and a manifest diagnostics tool for
  pasting a `.specregistry.json` to compare local spec versions against the registry.
  The page also includes an AI reporting test bench for synthetic feedback plus audit
  and efficacy smoke tests against the configured LLM provider.
- **Impact explorer** — the Impact page and `GET /api/v1/specs/:id/impact?delta=` expose
  the same blast-radius model outside the review flow, including consumers, dependencies,
  migration checklist items, and generated PR summary markdown.
- **LLM spec automation** — the Generate Specs workbench detects missing governance specs
  from repo evidence, uses purpose-based templates for common spec types, generates prompts
  or server-LLM drafts, and creates reviewed registry drafts rather than publishing directly.
  It also provides task planning, spec-aware PR/ticket checklists, generated audit prompts,
  section classification, context budget optimization, improvement suggestions, and spec
  pack composition. Automation features are individually flaggable, and LLM-backed variants
  run only when requested and enabled.
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
  Generated MCP configs use `specreg mcp`, and `specreg init` writes a root `AGENTS.md`
  bootstrap so agents know to read `SPECREGISTRY.md`, load governed skills, call MCP
  `get_specs`, and run the compliance loop before claiming completion.
- **Projects** — local manifests reported by `specreg init`, `specreg check`, `specreg sync`,
  and `specreg submit-drafts` let the Settings page show which repositories are using which
  spec set, how many reported specs are behind the latest approved versions, and which
  repo-specific specs exist as project overrides.
- **Reverse conformance audit** — `POST /api/v1/ai/audit` (and `specreg audit`) asks
  the configured server LLM whether a codebase snapshot *follows* its governed specs,
  reporting violations with spec/section/file citations. Checks adherence, not just spec currency.
- **Spec efficacy testing** — `POST /api/v1/ai/efficacy` runs a task with and without
  the spec in context and grades both, measuring whether a spec actually changes agent
  output ("earns its tokens" vs "no lift"). Trend, scheduled-run, prompt-regression,
  and token-ROI endpoints provide the reporting surface for model/spec comparisons.
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
  `specreg check` and `specreg verify` check provenance against `/api/v1/meta/public-key`
  before trusting local governed spec content.
- **Two-way git sync** — a subscribed repo editing `specs/*.md` (HMAC-verified GitHub push
  webhook) auto-opens a matching change request, closing the last drift hole.
- **Chat integrations** — webhooks in JSON, **Slack** (with interactive approve/reject
  buttons → `/api/v1/integrations/slack/actions`), or **Google Chat** format.

## API surface (v1)

```
GET  /api/v1/project-types              POST /api/v1/project-types
GET  /api/v1/specs                      POST /api/v1/specs
GET  /api/v1/specs/:id                  PUT  /api/v1/specs/:id          (drafts only)
GET  /api/v1/specs/:id/impact?delta=patch|minor|major
POST /api/v1/specs/:id/publish          GET  /api/v1/specs/:type/download   (zip)
POST /api/v1/specs/review               GET  /api/v1/reviews[?status=]
GET  /api/v1/reviews/sla
GET  /api/v1/reviews/:id/publish-preview
POST /api/v1/reviews/:id/approve        POST /api/v1/reviews/:id/reject
GET  /api/v1/ai/specs/:projectType      POST /api/v1/ai/feedback
POST /api/v1/ai/guidance-feedback       POST /api/v1/ai/resolve-guidance
GET  /api/v1/ai/feedback[?status=]      POST /api/v1/ai/feedback/:id/status
GET  /api/v1/ai/feedback/clusters       POST /api/v1/ai/feedback/:id/draft-fix
POST /api/v1/ai/feedback/clusters/status   POST /api/v1/ai/feedback/clusters/draft-fix
GET  /api/v1/ai/search?q=[&mode=fts|semantic|hybrid&project_type=&repo=]  GET /api/v1/ai/mcp-guide/:type
POST /api/v1/ai/audit                   POST /api/v1/ai/efficacy
GET  /api/v1/ai/efficacy/trends         POST /api/v1/ai/efficacy/scheduled-run
POST /api/v1/ai/regression-suite        GET /api/v1/ai/token-roi
POST /api/v1/specs/:id/promote          GET  /api/v1/specs/:type/compile?target=
GET  /api/v1/specs/:type/agent-pack     GET/POST/DELETE /api/v1/approval-policies
GET  /api/v1/spec-ownership             GET /api/v1/specs/dependency-map
GET  /api/v1/spec-purposes              POST /api/v1/spec-gaps
POST /api/v1/spec-generation/preview    POST /api/v1/spec-generation/draft
GET  /api/v1/automation/features        POST /api/v1/automation/task-plan
POST /api/v1/automation/ticket          POST /api/v1/automation/section-classifier
POST /api/v1/automation/context-budget  POST /api/v1/automation/audit-prompt
POST /api/v1/cli/code-trace-report      GET /api/v1/reports/overview
GET  /api/v1/automation/audit-prompt/:specId   GET /api/v1/automation/audit-prompts
POST /api/v1/automation/improvement-suggestions   POST /api/v1/automation/spec-pack
GET  /api/v1/specs/:type/download[?channel=beta]   GET /api/v1/meta/public-key
POST /api/v1/cli/stub-prompts           POST /api/v1/cli/sync-check
POST /api/v1/cli/manifest-diagnostics
GET/POST/PUT/DELETE /api/v1/templates   GET/POST/DELETE /api/v1/webhooks
GET/POST/DELETE /api/v1/subscriptions   GET /api/v1/sync-jobs · POST /api/v1/sync-jobs/run
GET  /api/v1/analytics/summary          GET /api/v1/reports/overview
POST /api/v1/auth/login                 GET /api/v1/auth/me
GET/POST /api/v1/auth/users             GET/POST/DELETE /api/v1/auth/api-keys
GET/PUT /api/v1/ldap/config             POST /api/v1/ldap/test · POST /api/v1/ldap/role-preview
GET  /api/v1/audit-log
GET/PUT /api/v1/llm/config             POST /api/v1/llm/test
GET  /api/v1/llm/tiering               PUT /api/v1/llm/tiering/tier/:tier
PUT  /api/v1/llm/tiering/routes        GET /api/v1/llm/models/:tier
GET/PUT /api/v1/embeddings/config      GET/POST /api/v1/embeddings/status|reindex
POST /api/v1/integrations/github/webhook   POST /api/v1/integrations/slack/actions
GET  /metrics
```

### Authentication & roles

Auth is **off by default** (anonymous access, free-text author names) for the zero-config
dev experience. Set `SPECREG_AUTH=required` to require a Bearer token / `x-api-key` on every
non-public route. A local `admin` account is seeded (password from `SPECREG_ADMIN_PASSWORD`,
default `admin` in dev). Roles: `admin` > `reviewer` > `author` > `agent`; approvals need
`reviewer`, settings need `admin`. Per-project-type required reviewers restrict who can approve;
approval policies can also require N recorded approvals before a change publishes.

#### Secured deployments (recommended for any real/shared use)

Run with `SPECREG_AUTH=required`. In this mode the server **refuses to boot while the `admin`
account still uses the default password `admin`** — set `SPECREG_ADMIN_PASSWORD` to your own, or
on a fresh database leave it unset and SpecRegistry generates a strong password and prints it
once at first start. This closes the "agent escalates to `admin`/`admin` and self-approves" path:
agents authenticate with their own enrolled `agent`-scoped token (issued by `specreg init` into
`.spec/credentials.json`), which can submit drafts and project-scoped specs but cannot approve,
publish, or reach admin routes. Combined with separation of duties (you cannot approve a change
you proposed), the governance is enforced server-side, not merely advised.

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
| `LLM_LOCAL_BASE_URL` / `LLM_CHEAP_BASE_URL` | Default cheap-tier local/network OpenAI-compatible endpoint |
| `LLM_LOCAL_MODEL` / `LLM_CHEAP_MODEL` | Default cheap-tier model |
| `LLM_CHEAP_API_KEY`, `LLM_CHEAP_MAX_TOKENS` | Optional cheap-tier API key and token budget |
| `LLM_FRONTIER_MODEL`, `LLM_FRONTIER_MAX_TOKENS` | Optional frontier-tier model and token budget overrides |
| `EMBEDDING_PROVIDER` | Semantic search provider: `local_hash`, `openai`, `gemini`, or `openai_compatible` |
| `EMBEDDING_MODEL` | Embedding model name |
| `EMBEDDING_BASE_URL` | OpenAI-compatible local/network embedding endpoint or hosted proxy |
| `EMBEDDING_API_KEY` | Embedding provider API key; optional for local endpoints |
| `EMBEDDING_DIMENSIONS` | Local deterministic embedding dimensions (default 128) |
| `SPECREG_AUTOMATION_ENABLED` | Master flag for automation APIs and workbench controls |
| `SPECREG_AUTOMATION_GAP_DETECTION` | Enable spec gap detection |
| `SPECREG_AUTOMATION_GENERATION` | Enable spec generation preview/draft creation |
| `SPECREG_AUTOMATION_LLM_GENERATION` | Enable requested LLM-backed automation variants |
| `SPECREG_AUTOMATION_TASK_PLANNER` | Enable task planning |
| `SPECREG_AUTOMATION_TICKET_GENERATOR` | Enable PR/ticket checklist generation |
| `SPECREG_AUTOMATION_MAINTENANCE` | Enable improvement suggestions |
| `SPECREG_AUTOMATION_PACK_COMPOSER` | Enable spec pack composition |
| `SPECREG_AUTOMATION_AUDIT_PROMPTS` | Enable generated audit prompts |
| `SPECREG_AUTOMATION_SECTION_CLASSIFIER` | Enable section classification |
| `SPECREG_AUTOMATION_CONTEXT_OPTIMIZER` | Enable context budget optimization |
| `SPECREG_CODE_METADATA_ENABLED` | Master default for code metadata and traceability features |
| `SPECREG_CODE_METADATA_TYPESCRIPT_JAVASCRIPT` | Enable TypeScript/JavaScript extraction defaults |
| `SPECREG_CODE_METADATA_PYTHON` | Enable Python extraction defaults |
| `SPECREG_CODE_METADATA_SQL` | Enable SQL extraction defaults |
| `SPECREG_CODE_METADATA_ROUTE_DETECTION` | Enable route metadata extraction defaults |
| `SPECREG_CODE_METADATA_SCHEMA_DETECTION` | Enable schema metadata extraction defaults |
| `SPECREG_CODE_METADATA_INLINE` | Default for optional inline metadata injection (default off) |
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

Server-side LLM features include AI draft-fix, reverse conformance audit, spec efficacy,
and LLM-backed automation. Configure them on the Settings page or with environment
variables.

The Settings page uses three configurable tiers:

- **Cheap / local**: default for classification, summarization, and task planning.
- **Standard**: default for ticket generation, maintenance suggestions, and connectivity tests.
- **Frontier**: default for spec generation, final audits, AI draft fixes, and efficacy scoring.

Each tier can use a different provider, model, base URL, API key, and max-token budget.
The routing table lets admins remap each feature to `cheap`, `standard`, or `frontier`
without changing code. The older `/api/v1/llm/config` endpoint still configures the
standard tier for compatibility.

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

Cheap-tier local model with a hosted frontier model:

```dotenv
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-4-5
ANTHROPIC_API_KEY=sk-ant-...
LLM_LOCAL_BASE_URL=http://host.docker.internal:1234
LLM_LOCAL_MODEL=google/gemma-4-12b-qat
LLM_CHEAP_MAX_TOKENS=4000
LLM_FRONTIER_MODEL=claude-opus-4-8
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
For LM Studio, either `http://host:1234` or `http://host:1234/v1` is accepted; root
OpenAI-compatible URLs are normalized to `/v1` automatically for model loading and chat
tests.
The Settings page can query available models from Anthropic, OpenAI, Gemini, and
OpenAI-compatible providers that expose `/models`.

Spec download bundles are ed25519-signed; the keypair is generated on first use and stored
in the database. `specreg verify` checks bundle provenance against the public key.

### Automation feature flags

Automation APIs are enabled by default. Set any flag to `false`, `0`, `off`, or `no` to
disable that capability for a deployment. The Generate Specs workbench reads
`GET /api/v1/automation/features` and disables controls for unavailable features.
Admins can also manage these flags on **Settings -> Features**. Saved settings are stored
in the registry database and override environment defaults.

LLM-backed automation only runs when both conditions are true:

1. `SPECREG_AUTOMATION_LLM_GENERATION` is enabled.
2. The request explicitly asks for LLM use, such as the workbench **Use server LLM** toggle.

Without LLM mode, automation endpoints use deterministic templates, spec metadata, repo
evidence, and existing registry telemetry. This keeps CI/server deployments usable even when
no model provider is configured.

The same Settings screen also exposes code metadata and AST traceability controls. Current
available toggles cover `specreg code-map` style extraction for TypeScript/JavaScript,
Python, SQL, routes, schemas, stable IDs, and sidecar metadata. Planned toggles are visible
for inline metadata injection, traceability graphs, semantic drift, code embeddings, and
code-to-spec coverage reports so deployments can decide which features should be allowed as
those slices are implemented.

### Troubleshooting

- **CLI command not found**: run `npm run build`, then `npm link -w @specregistry/cli -w @specregistry/mcp`,
  or invoke `node packages/cli/dist/index.js ...` directly.
- **Agents cannot reach the registry in Docker**: set `SPECREG_PUBLIC_URL` to the URL reachable
  from developer machines and agent environments.
- **Auth-required CLI/MCP calls fail**: pass `--token <token>` or set `SPECREG_TOKEN`.
- **LLM features say a key is missing**: configure the provider on Settings or set the matching
  `LLM_*` / provider API key environment variables.
- **Local model server is on the host while SpecRegistry runs in Docker**: use
  `http://host.docker.internal:<port>/v1` as `LLM_BASE_URL` on macOS/Windows.
- **Generated specs conflict with governed files**: keep generated drafts outside `specs/`
  until `specreg submit-drafts` sends them through the registry workflow.

### Further reading

- [Agent feedback workflow](README-AGENTS.md)
- [Google style guide integration](README-GOOGLE-STYLEGUIDES.md)
- [Product specification](docs/SPEC.md)
- [SDD and tokenomics operating model](docs/SDD_TOKENOMICS.md)
- [Add-on backlog](docs/TODO.md)
- [AI-SDD sample spec pack](samples/ai-sdd/README.md)
