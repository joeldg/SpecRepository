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
| `packages/server` | Fastify API + SQLite storage, review workflow, zip downloads, AI feedback ingestion, prompt stubs |
| `packages/web` | React management dashboard (specs, diffs, reviews, feedback alerts, project types) |
| `packages/cli` | `specreg` developer CLI (`init`, `generate`) |
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
node packages/cli/dist/index.js init

# Existing project: scan the codebase, fetch tailored LLM prompts into .spec/prompts/
node packages/cli/dist/index.js generate

# Flags: --server <url> (or $SPECREG_SERVER), --type <name> to skip the prompt,
#        --dir (init output), --out (generate output)
```

`npm link -w @specregistry/cli` installs `specreg` onto your PATH.

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
  alerts on the dashboard and on the affected spec until triaged.

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
POST /api/v1/cli/stub-prompts
```

There is no authentication in this version; author/reviewer names are free-text
(the web UI keeps an "acting as" identity in localStorage).
