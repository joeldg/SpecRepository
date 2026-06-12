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
| `packages/server` | Fastify API + SQLite storage, review workflow, zip downloads, AI feedback ingestion, prompt stubs, FTS5 search, webhooks, analytics, git push-back |
| `packages/web` | React management dashboard (specs, diffs, reviews, feedback alerts, templates, settings, search, analytics) |
| `packages/cli` | `specreg` developer CLI (`init`, `generate`, `check`, `sync`) |
| `packages/mcp` | `specreg-mcp` — MCP stdio server so AI agents read specs / search / file feedback natively |
| `packages/shared` | Shared TypeScript domain types + semver helpers |

## Quick start

```sh
npm install
npm run build

# Development: API on :4000 (auto-seeds Thinkom demo data on first run)
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

# Flags: --server <url> (or $SPECREG_SERVER), --type <name> to skip the prompt,
#        --dir (spec directory), --out (generate output)
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
  The Thinkom types are just seed data (`packages/server/src/seed.ts`).
- **Lifecycle** — new specs start as `0.1.0` drafts and are edited directly. Publishing
  makes them `1.0.0`. Published specs only change through a change request
  (`POST /api/v1/specs/review`): the server stores a unified diff, the spec enters
  `pending_review`, and approval bumps the semver by the requested delta
  (major/minor/patch) and records an immutable version snapshot.
- **AI feedback loop** — agents read `GET /api/v1/ai/specs/:projectType` and report
  spec ambiguities/contradictions to `POST /api/v1/ai/feedback`, which appear as
  alerts on the dashboard and on the affected spec until triaged. From any feedback
  item, **Draft AI fix** sends the spec + complaint to Claude (`claude-opus-4-8`,
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
POST /api/v1/ai/feedback/:id/draft-fix  GET  /api/v1/ai/search?q=[&project_type=]
POST /api/v1/cli/stub-prompts           POST /api/v1/cli/sync-check
GET/POST/PUT/DELETE /api/v1/templates   GET/POST/DELETE /api/v1/webhooks
GET/POST/DELETE /api/v1/subscriptions   GET /api/v1/sync-jobs · POST /api/v1/sync-jobs/run
GET  /api/v1/analytics/summary
```

Server environment variables: `PORT`, `SPECREG_DB`, `ANTHROPIC_API_KEY` (AI draft-fix),
`GITHUB_TOKEN` (git push-back PRs).

There is no authentication in this version; author/reviewer names are free-text
(the web UI keeps an "acting as" identity in localStorage).
