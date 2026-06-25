import type { Db } from "./db.js";
import { now, uuid } from "./db.js";
import { createUser } from "./lib/auth.js";
import { auditPromptForSpec } from "./lib/specAutomation.js";

const DESIGN_STUB = `You are an expert software architect. Analyze the provided file structure and codebase context:
[CONTEXT]

Generate a comprehensive DESIGN.md file conforming to the standard template. The output must detail:
1. System Architecture and component interactions.
2. High-level design patterns implemented.
3. Data flow patterns.

The project is of type "[PROJECT_TYPE]" and primarily uses: [LANGUAGES].

Output strict markdown. Do not include chat conversational text.`;

const STRUCTURE_STUB = `You are an AI system specialized in codebase mapping. Analyze the following directory tree and file signatures:
[TREE]

Generate a STRUCTURE.md file that maps out:
1. Core directory purposes.
2. Entry points and configuration files.
3. Dependency mapping between modules.

The project is of type "[PROJECT_TYPE]" and primarily uses: [LANGUAGES].

Output strict markdown. Avoid fluff.`;

interface SeedSpec {
  filename: string;
  content: string;
}

function insertProjectType(
  db: Db,
  name: string,
  scope: "global" | "project_type",
  industry: string | null,
  description: string | null
): string {
  const id = uuid();
  const ts = now();
  db.prepare(
    `INSERT INTO project_types (id, name, scope, industry, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, scope, industry, description, ts, ts);
  return id;
}

const DEFAULT_PROJECT_TYPES = [
  {
    name: "MCP Server / Agent Integration",
    industry: "AI / Developer Tools",
    description:
      "Model Context Protocol servers, agent tool schemas, prompt/context contracts, feedback loops, and agent onboarding.",
  },
  {
    name: "SaaS Backend API",
    industry: "Software / SaaS",
    description:
      "Multi-tenant APIs, authentication, database migrations, billing/webhooks, observability, rate limits, and compatibility contracts.",
  },
  {
    name: "CLI Tool / Developer Tooling",
    industry: "Developer Tools",
    description:
      "Command-line tools, flags, config files, exit codes, stdout/stderr contracts, CI behavior, and backwards compatibility.",
  },
  {
    name: "AI-SDD Governed Project",
    industry: "AI / Software Delivery",
    description:
      "Strict Spec Driven Development with tokenomics, spec conflict detection, audit prompts, agent feedback, and generated context rules.",
  },
  {
    name: "Data Platform / ETL Pipeline",
    industry: "Data Engineering",
    description:
      "Schemas, lineage, batch/stream processing, idempotency, backfills, PII handling, data quality checks, and warehouse contracts.",
  },
  {
    name: "Internal Admin Tool",
    industry: "Operations Software",
    description:
      "Dense operational dashboards, auditability, role-based access, data tables/forms, imports/exports, and repeatable workflows.",
  },
  {
    name: "Mobile App",
    industry: "Mobile Software",
    description:
      "iOS, Android, or React Native apps with offline behavior, permissions, app store release, analytics, crash reporting, and deep links.",
  },
] satisfies Array<{ name: string; industry: string; description: string }>;

function seedDefaultProjectTypes(db: Db): number {
  let inserted = 0;
  for (const projectType of DEFAULT_PROJECT_TYPES) {
    const existing = db
      .prepare("SELECT id FROM project_types WHERE name = ? COLLATE NOCASE")
      .get(projectType.name);
    if (existing) continue;
    insertProjectType(db, projectType.name, "project_type", projectType.industry, projectType.description);
    inserted++;
  }
  return inserted;
}

function insertPublishedSpec(db: Db, projectTypeId: string, spec: SeedSpec): void {
  const id = uuid();
  const ts = now();
  const auditPrompt = auditPromptForSpec({
    id,
    filename: spec.filename,
    content: spec.content,
    current_version: "1.0.0",
  });
  db.prepare(
    `INSERT INTO specs (id, project_type_id, filename, current_version, status, content, updated_by, audit_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '1.0.0', 'published', ?, 'seed', ?, ?, ?)`
  ).run(id, projectTypeId, spec.filename, spec.content, auditPrompt, ts, ts);
  db.prepare(
    `INSERT INTO spec_versions (id, spec_id, version, content, published_by, published_at)
     VALUES (?, ?, '1.0.0', ?, 'seed', ?)`
  ).run(uuid(), id, spec.content, ts);
}

/** Default conformance templates; seeded independently so existing databases pick them up. */
function seedTemplates(db: Db): void {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM spec_templates").get() as { n: number };
  if (existing.n > 0) return;
  const insert = db.prepare(
    `INSERT INTO spec_templates (id, filename, required_sections, content_template, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const ts = now();
  insert.run(
    uuid(),
    "DESIGN.md",
    JSON.stringify(["System Architecture", "Design Patterns", "Data Flow"]),
    `# <Project> — Design Specification

## System Architecture

_Describe the components and how they interact._

## Design Patterns

_List the high-level patterns in use and why._

## Data Flow

_Describe how data moves through the system._
`,
    "Every DESIGN.md must document architecture, patterns, and data flow.",
    ts,
    ts
  );
  insert.run(
    uuid(),
    "STRUCTURE.md",
    JSON.stringify(["Entry Points"]),
    `# <Project> — Repository Structure

| Path | Purpose |
| --- | --- |
| \`src/\` | _purpose_ |

## Entry Points

_List the main entry points and configuration files._
`,
    "Every STRUCTURE.md must map directories and list entry points.",
    ts,
    ts
  );
}

/** Bootstrap admin for local auth; password from SPECREG_ADMIN_PASSWORD (default "admin"). */
function seedAdmin(db: Db): void {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (existing.n > 0) return;
  createUser(db, {
    username: "admin",
    role: "admin",
    password: process.env.SPECREG_ADMIN_PASSWORD ?? "admin",
    display_name: "Administrator",
  });
}

/** Seeds the Acme demo configuration. No-op if any project type already exists. */
export function seed(db: Db): boolean {
  seedTemplates(db);
  seedAdmin(db);
  // Backfill missing audit prompts for existing specs (runs once after migration 15)
  const missing = db.prepare("SELECT COUNT(*) AS n FROM specs WHERE (audit_prompt IS NULL OR audit_prompt = '') AND deleted_at IS NULL").get() as { n: number };
  if (missing.n > 0) {
    const specs = db.prepare("SELECT id, filename, content, current_version FROM specs WHERE (audit_prompt IS NULL OR audit_prompt = '') AND deleted_at IS NULL").all() as Array<{
      id: string;
      filename: string;
      content: string;
      current_version: string;
    }>;
    const update = db.prepare("UPDATE specs SET audit_prompt = ?, updated_at = ? WHERE id = ?");
    for (const spec of specs) {
      const prompt = auditPromptForSpec(spec);
      update.run(prompt, now(), spec.id);
    }
  }

  const existing = db.prepare("SELECT COUNT(*) AS n FROM project_types").get() as { n: number };
  if (existing.n > 0) {
    seedDefaultProjectTypes(db);
    return false;
  }

  const globalId = insertProjectType(
    db,
    "Global",
    "global",
    null,
    "Organization-wide specifications that apply to every project type."
  );
  insertPublishedSpec(db, globalId, {
    filename: "GLOBAL_SECURITY.md",
    content: `# Global Security Standards

## Scope
These rules apply to every project in the organization, regardless of project type.

## Requirements
1. **Secrets** must never be committed to source control. Use the approved secret manager.
2. **Dependencies** must be pinned and scanned weekly for CVEs.
3. **Network services** must default to TLS 1.2+ and deny-by-default firewall rules.
4. **Authentication** flows must be reviewed by the security team before release.

## AI Agent Directives
AI agents generating code MUST refuse to embed credentials and MUST flag any spec
contradiction via the feedback endpoint rather than guessing.
`,
  });
  insertPublishedSpec(db, globalId, {
    filename: "CODING_STANDARDS.md",
    content: `# General Coding Standards

## Principles
- Prefer clarity over cleverness; code is read far more than it is written.
- Every public interface requires documentation in the repository's spec files.
- All changes ship with tests that exercise the changed behavior.

## Versioning
All specification documents follow strict Semantic Versioning (MAJOR.MINOR.PATCH).
Breaking guidance changes are MAJOR; new guidance is MINOR; clarifications are PATCH.

## Reviews
No specification becomes active without an approved review in SpecRegistry.
`,
  });

  const edgeId = insertProjectType(
    db,
    "Acme Edge Device",
    "project_type",
    "Aerospace/Telecommunications",
    "Phased-array antenna edge devices: embedded controllers, RF front-end management."
  );
  insertPublishedSpec(db, edgeId, {
    filename: "DESIGN.md",
    content: `# Acme Edge Device — Design Specification

## System Architecture
Edge devices are composed of three planes:
1. **Control plane** — supervisory MCU coordinating beam steering and health telemetry.
2. **Data plane** — RF front-end with FPGA-based signal conditioning.
3. **Management plane** — out-of-band service interface for fleet operations.

## Design Patterns
- State machines for mode transitions (ACQUIRE → TRACK → DEGRADED → SAFE).
- Watchdog-supervised tasks; no dynamic allocation after initialization.

## Data Flow
Telemetry flows MCU → management plane at 1 Hz; alarms are event-driven.
`,
  });
  insertPublishedSpec(db, edgeId, {
    filename: "STRUCTURE.md",
    content: `# Acme Edge Device — Repository Structure

| Path | Purpose |
| --- | --- |
| \`fw/\` | Embedded firmware (C/C++), one subdirectory per board |
| \`fpga/\` | HDL sources and constraint files |
| \`tools/\` | Host-side flashing, provisioning, and test utilities |
| \`docs/\` | Datasheets and interface control documents |

## Entry Points
- \`fw/<board>/main.c\` — firmware entry
- \`tools/provision.py\` — manufacturing provisioning

## Rules
- HDL and firmware interfaces must be kept in lockstep via \`docs/icd/\`.
`,
  });
  insertPublishedSpec(db, edgeId, {
    filename: "API.md",
    content: `# Acme Edge Device — Management API

## Transport
CoAP over DTLS on the management plane interface. JSON payloads, snake_case keys.

## Resources
- \`GET /telemetry\` — current beam state, temperatures, lock status
- \`POST /mode\` — request mode transition; body: { "target": "TRACK" }
- \`GET /health\` — watchdog counters and fault log tail

## Constraints
All commands must be idempotent; retries are expected on lossy links.
`,
  });

  const fwId = insertProjectType(
    db,
    "Acme Firmware",
    "project_type",
    "Aerospace/Telecommunications",
    "Shared firmware platform: RTOS components, drivers, and build infrastructure."
  );
  insertPublishedSpec(db, fwId, {
    filename: "DESIGN.md",
    content: `# Acme Firmware Platform — Design Specification

## System Architecture
A layered RTOS platform: board support packages at the bottom, a hardware
abstraction layer, shared services (logging, OTA, crypto), and application tasks.

## Design Patterns
- HAL interfaces are pure C headers with one implementation per target.
- Services communicate via message queues only; no shared mutable state.

## Data Flow
OTA images are signed and staged to the inactive bank; swap occurs on verified boot.
`,
  });
  insertPublishedSpec(db, fwId, {
    filename: "STRUCTURE.md",
    content: `# Acme Firmware Platform — Repository Structure

| Path | Purpose |
| --- | --- |
| \`bsp/\` | Board support packages |
| \`hal/\` | Hardware abstraction interfaces and implementations |
| \`services/\` | Logging, OTA, crypto, telemetry services |
| \`apps/\` | Application task sets per product |

## Build
CMake presets per target; \`ctest\` runs the host-side unit suite.
`,
  });

  const webId = insertProjectType(
    db,
    "Web App Standard",
    "project_type",
    "Software",
    "Standard internal web application stack: TypeScript, React, REST APIs."
  );
  insertPublishedSpec(db, webId, {
    filename: "DESIGN.md",
    content: `# Web App Standard — Design Specification

## System Architecture
Single-page React frontend, REST backend, relational store. Server-rendered
pages only where SEO requires it.

## Design Patterns
- API handlers are thin; domain logic lives in service modules.
- Frontend state: server state via fetch hooks, UI state local to components.

## Data Flow
All mutations go through the API layer; the frontend never writes to storage directly.
`,
  });
  insertPublishedSpec(db, webId, {
    filename: "STRUCTURE.md",
    content: `# Web App Standard — Repository Structure

| Path | Purpose |
| --- | --- |
| \`src/api/\` | Route handlers and request validation |
| \`src/services/\` | Domain logic |
| \`src/web/\` | React application |
| \`test/\` | Unit and integration tests |

## Entry Points
- \`src/index.ts\` — server entry
- \`src/web/main.tsx\` — frontend entry
`,
  });

  seedDefaultProjectTypes(db);

  const insertStub = db.prepare(
    `INSERT INTO stub_prompts (id, target_filename, template, description, project_type_id)
     VALUES (?, ?, ?, ?, NULL)`
  );
  insertStub.run(
    uuid(),
    "DESIGN.md",
    DESIGN_STUB,
    "Generates a DESIGN.md from codebase context for existing projects."
  );
  insertStub.run(
    uuid(),
    "STRUCTURE.md",
    STRUCTURE_STUB,
    "Generates a STRUCTURE.md from a directory tree for existing projects."
  );

  return true;
}
