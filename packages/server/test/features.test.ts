import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb } from "../src/db.js";
import { seed } from "../src/seed.js";
import { sanitizeDraftFixOutput } from "../src/lib/aifix.js";
import { buildAdminTestApp } from "./helpers.js";

let app: FastifyInstance;

beforeEach(async () => {
  const db = createDb(":memory:");
  seed(db);
  app = await buildAdminTestApp(db);
});

afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
});

async function getJson(url: string) {
  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function findSpec(filename: string, typeName: string) {
  const specs = await getJson("/api/v1/specs");
  return specs.find((s: any) => s.filename === filename && s.project_type_name === typeName);
}

describe("AI draft-fix output sanitation", () => {
  it("removes model reasoning before the revised markdown document", () => {
    const current = "# Global Security\n\n## Scope\n\nAll projects.\n";
    const raw = `*   The agent feedback mentions: reports:test-fixture.
*   Looking at the current spec GLOBAL_SECURITY.md:
    *   Scope: All projects.
*   I should preserve the structure.

# Global Security

## Scope

All projects.

## Requirements

Use TLS.`;
    const cleaned = sanitizeDraftFixOutput(raw, current);
    expect(cleaned).toBe("# Global Security\n\n## Scope\n\nAll projects.\n\n## Requirements\n\nUse TLS.");
    expect(cleaned).not.toContain("agent feedback mentions");
    expect(cleaned).not.toContain("Looking at the current spec");
  });

  it("strips think tags and markdown fences from model output", () => {
    const current = "# API\n\n## Requirements\n\nExisting.\n";
    const raw = `<think>I will reason here.</think>

\`\`\`markdown
# API

## Requirements

Existing. Clarified.
\`\`\``;
    expect(sanitizeDraftFixOutput(raw, current)).toBe("# API\n\n## Requirements\n\nExisting. Clarified.");
  });
});

describe("governed agent skills", () => {
  it("seeds safe base skills and supports admin-managed skill lifecycle", async () => {
    const initial = await getJson("/api/v1/skills");
    expect(initial.length).toBeGreaterThanOrEqual(6);
    expect(initial.every((skill: any) => skill.status === "active")).toBe(true);
    expect(initial.find((skill: any) => skill.slug === "load-governed-specs")).toMatchObject({
      built_in: 1,
      risk_level: "safe",
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/skills",
      payload: {
        name: "Prepare deployment",
        slug: "Prepare Deployment!",
        description: "Prepare a reviewed release plan.",
        instructions: "Build the release checklist and stop before deployment.",
        risk_level: "restricted",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ slug: "prepare-deployment", risk_level: "restricted", status: "active", built_in: 0 });

    const disabled = await app.inject({
      method: "PUT",
      url: `/api/v1/skills/${created.json().id}`,
      payload: { status: "disabled" },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().status).toBe("disabled");
    const edited = await app.inject({
      method: "PUT",
      url: `/api/v1/skills/${created.json().id}`,
      payload: {
        name: "Prepare release",
        description: "Prepare a reviewed release and rollback plan.",
        instructions: "Build the release checklist, rollback plan, and stop before deployment.",
        risk_level: "safe",
        status: "active",
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({
      slug: "prepare-deployment",
      name: "Prepare release",
      description: "Prepare a reviewed release and rollback plan.",
      instructions: "Build the release checklist, rollback plan, and stop before deployment.",
      risk_level: "safe",
      status: "active",
    });
    await app.inject({
      method: "PUT",
      url: `/api/v1/skills/${created.json().id}`,
      payload: { status: "disabled" },
    });
    expect((await getJson("/api/v1/skills")).some((skill: any) => skill.id === created.json().id)).toBe(false);
    expect((await getJson("/api/v1/skills?include_disabled=true")).find((skill: any) => skill.id === created.json().id).status).toBe("disabled");

    const removed = await app.inject({ method: "DELETE", url: `/api/v1/skills/${created.json().id}` });
    expect(removed.statusCode).toBe(204);
    const builtInDelete = await app.inject({ method: "DELETE", url: `/api/v1/skills/${initial[0].id}` });
    expect(builtInDelete.statusCode).toBe(409);
  });
});

describe("sync-check (CLI drift detection)", () => {
  it("records repository manifest consumers and reports outdated counts", async () => {
    const report = await app.inject({
      method: "POST",
      url: "/api/v1/cli/manifest-report",
      payload: {
        repo: "github.com/acme/device",
        branch: "main",
        commit_sha: "abc123",
        project_type: "Acme Edge Device",
        specs_path: "specs",
        manifest_path: "specs/.specregistry.json",
        specs: [
          { filename: "DESIGN.md", version: "0.9.0", project_type: "Acme Edge Device", sha256: "old" },
          { filename: "GLOBAL_SECURITY.md", version: "1.0.0", project_type: "Global", sha256: "current" },
        ],
      },
    });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({ ok: true, repo: "github.com/acme/device", specs: 2 });

    const consumers = await app.inject({ method: "GET", url: "/api/v1/cli/consumers" });
    expect(consumers.statusCode).toBe(200);
    expect(consumers.json()).toEqual([
      expect.objectContaining({
        repo: "github.com/acme/device",
        project_type_name: "Acme Edge Device",
        spec_count: 2,
        outdated_count: 1,
        manifest_path: "specs/.specregistry.json",
      }),
    ]);
  });

  it("records code trace reports for repository consumers", async () => {
    const report = await app.inject({
      method: "POST",
      url: "/api/v1/cli/code-trace-report",
      payload: {
        repo: "github.com/acme/traceable",
        branch: "main",
        commit_sha: "abc123",
        project_type: "Acme Edge Device",
        trace: {
          schema_version: 1,
          generated_at: "2026-06-27T00:00:00.000Z",
          specs_dir: "specs",
          spec_count: 1,
          entity_count: 3,
          coverage: {
            governed_entity_count: 2,
            linked_entity_count: 1,
            unlinked_entity_count: 1,
            coverage_ratio: 0.5,
          },
          drift: { score: 0.5, severity: "medium" },
          aliases: [{ previous_id: "code:function:old", current_id: "code:function:new", reason: "same_hash" }],
          links: [
            {
              entity_id: "code:route:abc",
              entity_name: "GET /users/:id",
              entity_kind: "route",
              spec_filename: "API.md",
              confidence: 0.9,
              reasons: ["route path appears in spec"],
            },
          ],
          unlinked_entities: [{ id: "code:schema:def", kind: "schema", path: "db.sql", name: "users", signature: "CREATE TABLE users" }],
        },
      },
    });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({
      ok: true,
      repo: "github.com/acme/traceable",
      coverage_ratio: 0.5,
      drift_score: 0.5,
      drift_severity: "medium",
      links: 1,
    });

    const overview = await getJson("/api/v1/reports/overview");
    expect(overview.code_trace_reports.find((row: any) => row.repo === "github.com/acme/traceable")).toMatchObject({
      coverage_ratio: 0.5,
      drift_severity: "medium",
      link_count: 1,
      aliases_count: 1,
    });
    expect(overview.projects.find((row: any) => row.repo === "github.com/acme/traceable")).toMatchObject({
      code_coverage_ratio: 0.5,
      code_drift_score: 0.5,
      code_drift_severity: "medium",
    });
  });

  it("allows project-scoped specs to override project-type specs for one repo", async () => {
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/v1/cli/manifest-report",
        payload: {
          repo: "github.com/acme/device",
          project_type: "Acme Edge Device",
          specs: [],
        },
      })
    ).json();
    const types = await getJson("/api/v1/project-types");
    const edge = types.find((t: any) => t.name === "Acme Edge Device");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/specs",
      payload: {
        project_type_id: edge.id,
        project_id: project.project_id,
        filename: "API.md",
        content: "# Project-only API\n\nProject-only endpoint guidance applies here.\n",
        updated_by: "codex-test",
      },
    });
    expect(created.statusCode).toBe(201);
    await app.inject({ method: "POST", url: `/api/v1/specs/${created.json().id}/publish`, payload: { published_by: "codex-test" } });

    const download = await app.inject({
      method: "GET",
      url: "/api/v1/specs/Acme%20Edge%20Device/download?repo=github.com%2Facme%2Fdevice",
    });
    expect(download.statusCode).toBe(200);
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(Buffer.from(download.rawPayload));
    expect(zip.readAsText("API.md")).toContain("Project-only API");
    const manifest = JSON.parse(zip.readAsText(".specregistry.json"));
    expect(manifest.project).toBe("github.com/acme/device");
    expect(manifest.specs.find((s: any) => s.filename === "API.md")).toMatchObject({ scope: "project" });

    const search = await getJson(
      "/api/v1/ai/search?q=Project-only&project_type=Acme%20Edge%20Device&repo=github.com%2Facme%2Fdevice"
    );
    expect(search.project).toBe("github.com/acme/device");
    expect(search.results[0]).toMatchObject({ filename: "API.md", effective_scope: "project" });

    const baseCompiled = await getJson("/api/v1/specs/Acme%20Edge%20Device/compile?target=claude");
    expect(baseCompiled.content).toContain("Acme Edge Device — Management API");
    expect(baseCompiled.content).not.toContain("Project-only API");

    const projectCompiled = await getJson(
      "/api/v1/specs/Acme%20Edge%20Device/compile?target=claude&repo=github.com%2Facme%2Fdevice"
    );
    expect(projectCompiled.content).toContain("Project-only API");
    expect(projectCompiled.content).not.toContain("Acme Edge Device — Management API");

    const packRes = await app.inject({
      method: "GET",
      url: "/api/v1/specs/Acme%20Edge%20Device/agent-pack?repo=github.com%2Facme%2Fdevice",
    });
    expect(packRes.statusCode).toBe(200);
    const pack = new AdmZip(Buffer.from(packRes.rawPayload));
    expect(pack.readAsText("CLAUDE.md")).toContain("Project-only API");
    expect(pack.readAsText(".mcp.json")).toContain("github.com/acme/device");

    const drift = await app.inject({
      method: "POST",
      url: "/api/v1/cli/sync-check",
      payload: {
        repo: "github.com/acme/device",
        project_type: "Acme Edge Device",
        specs: [{ filename: "API.md", version: "1.0.0" }],
      },
    });
    expect(drift.json().up_to_date).toContain("API.md");
  });

  it("reports drift after a spec version bump", async () => {
    const summaries = await getJson("/api/v1/specs");
    const currentManifest = summaries
      .filter((s: any) => s.status === "published" && (s.project_type_name === "Acme Edge Device" || s.project_type_scope === "global"))
      .map((s: any) => ({ filename: s.filename, version: s.current_version }));
    const clean = await app.inject({
      method: "POST",
      url: "/api/v1/cli/sync-check",
      payload: {
        project_type: "Acme Edge Device",
        specs: currentManifest,
      },
    });
    expect(clean.statusCode).toBe(200);
    expect(clean.json().drift).toBe(false);
    expect(clean.json().up_to_date.length).toBe(currentManifest.length);

    // Bump DESIGN.md via the review workflow
    const spec = await findSpec("DESIGN.md", "Acme Edge Device");
    const cr = (
      await app.inject({
        method: "POST",
        url: "/api/v1/specs/review",
        payload: {
          spec_id: spec.id,
          proposed_content: spec.filename + "\n\n# Acme Edge Device — Design Specification\n\n## System Architecture\nv2\n\n## Design Patterns\nv2\n\n## Data Flow\nv2\n",
          version_delta: "minor",
          proposed_by: "joel",
        },
      })
    ).json();
    await app.inject({ method: "POST", url: `/api/v1/reviews/${cr.id}/approve`, payload: { reviewed_by: "r" } });

    const drifted = await app.inject({
      method: "POST",
      url: "/api/v1/cli/sync-check",
      payload: {
        project_type: "Acme Edge Device",
        specs: [{ filename: "DESIGN.md", version: "1.0.0" }],
      },
    });
    const body = drifted.json();
    expect(body.drift).toBe(true);
    expect(body.outdated).toEqual([
      {
        filename: "DESIGN.md",
        local_version: "1.0.0",
        latest_version: "1.1.0",
        severity: "minor",
        within_pin: true,
      },
    ]);
    expect(body.missing_locally.length).toBe(currentManifest.length - 1);
  });

  it("diagnoses an uploaded manifest without storing a project report", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cli/manifest-diagnostics",
      payload: {
        manifest: {
          project_type: "Acme Edge Device",
          project: "github.com/acme/pasted",
          specs: [
            { filename: "DESIGN.md", version: "0.9.0", pin: "^0.9.0" },
            { filename: "LOCAL_ONLY.md", version: "1.0.0" },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      project_type: "Acme Edge Device",
      project: "github.com/acme/pasted",
      drift: true,
      local_count: 2,
      local_only_count: 1,
      breaking_count: 1,
    });
    expect(res.json().outdated[0]).toMatchObject({
      filename: "DESIGN.md",
      local_version: "0.9.0",
      latest_version: "1.0.0",
      within_pin: false,
    });
    expect(res.json().not_on_server).toEqual(["LOCAL_ONLY.md"]);
  });
});

describe("search", () => {
  it("finds sections and scopes by project type", async () => {
    const res = await getJson("/api/v1/ai/search?q=TLS%20firewall");
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].filename).toBe("GLOBAL_SECURITY.md");

    const scoped = await getJson(
      "/api/v1/ai/search?q=beam%20steering&project_type=Acme%20Edge%20Device"
    );
    expect(scoped.results.some((r: any) => r.filename === "DESIGN.md")).toBe(true);

    const wrongScope = await getJson("/api/v1/ai/search?q=beam%20steering&project_type=Web%20App%20Standard");
    expect(wrongScope.results.length).toBe(0);
  });

  it("does not choke on FTS syntax in queries", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/ai/search?q=" + encodeURIComponent('"AND" (NOT*') });
    expect(res.statusCode).toBe(200);
  });

  it("reindexes after an approved change", async () => {
    const spec = await findSpec("DESIGN.md", "Web App Standard");
    const cr = (
      await app.inject({
        method: "POST",
        url: "/api/v1/specs/review",
        payload: {
          spec_id: spec.id,
          proposed_content:
            "# Web App Standard — Design Specification\n\n## System Architecture\nUses the zanzibar permission model.\n\n## Design Patterns\nx\n\n## Data Flow\nx\n",
          version_delta: "minor",
          proposed_by: "joel",
        },
      })
    ).json();
    await app.inject({ method: "POST", url: `/api/v1/reviews/${cr.id}/approve`, payload: { reviewed_by: "r" } });
    const res = await getJson("/api/v1/ai/search?q=zanzibar");
    expect(res.results.length).toBe(1);
    expect(res.results[0].current_version).toBe("1.1.0");
  });

  it("indexes section embeddings and supports semantic and hybrid search modes", async () => {
    const initial = await getJson("/api/v1/embeddings/status");
    expect(initial.ready).toBe(false);

    const reindex = await app.inject({ method: "POST", url: "/api/v1/embeddings/reindex" });
    expect(reindex.statusCode).toBe(200);
    expect(reindex.json().status.ready).toBe(true);
    expect(reindex.json().status.indexed_sections).toBeGreaterThan(0);

    const semantic = await getJson("/api/v1/ai/search?q=TLS%20firewall&mode=semantic");
    expect(semantic.mode).toBe("semantic");
    expect(semantic.results.length).toBeGreaterThan(0);
    expect(semantic.results[0]).toMatchObject({
      match_type: "semantic",
      score: expect.any(Number),
      explanation: expect.stringContaining("Vector similarity"),
    });

    const hybrid = await getJson("/api/v1/ai/search?q=TLS%20firewall&mode=hybrid");
    expect(hybrid.mode).toBe("hybrid");
    expect(hybrid.results.length).toBeGreaterThan(0);
    expect(hybrid.results.some((row: any) => row.match_type === "hybrid")).toBe(true);
  });
});

describe("templates & lint", () => {
  it("flags missing required sections on a change request", async () => {
    const spec = await findSpec("DESIGN.md", "Acme Firmware");
    const cr = (
      await app.inject({
        method: "POST",
        url: "/api/v1/specs/review",
        payload: {
          spec_id: spec.id,
          proposed_content: "# Firmware Design\n\n## System Architecture\nOnly architecture, nothing else.\n",
          version_delta: "major",
          proposed_by: "joel",
        },
      })
    ).json();
    const lint = JSON.parse(cr.lint);
    expect(lint.ok).toBe(false);
    expect(lint.missing_sections).toEqual(["Design Patterns", "Data Flow"]);
  });

  it("supports template CRUD", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/templates",
      payload: { filename: "RUNBOOK.md", required_sections: ["Operations", "Rollback"] },
    });
    expect(created.statusCode).toBe(201);
    const dup = await app.inject({
      method: "POST",
      url: "/api/v1/templates",
      payload: { filename: "runbook.md", required_sections: [] },
    });
    expect(dup.statusCode).toBe(409);
    const all = await getJson("/api/v1/templates");
    expect(all.length).toBe(4); // 3 seeded + RUNBOOK.md
  });
});

describe("compatibility report", () => {
  it("suggests major when sections are removed and flags undersized deltas", async () => {
    const spec = await findSpec("STRUCTURE.md", "Web App Standard");
    const cr = (
      await app.inject({
        method: "POST",
        url: "/api/v1/specs/review",
        payload: {
          spec_id: spec.id,
          proposed_content: "# Web App Standard — Repository Structure\n\nslimmed down\n",
          version_delta: "patch",
          proposed_by: "joel",
        },
      })
    ).json();
    const compat = JSON.parse(cr.compatibility);
    expect(compat.suggested_delta).toBe("major");
    expect(compat.removed_sections).toContain("Entry Points");
    expect(compat.agrees_with_requested).toBe(false);
  });
});

describe("webhooks", () => {
  it("delivers an event on review approval", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      payload: { url: "https://hooks.example.com/x", events: ["review.approved"], format: "json" },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const spec = await findSpec("API.md", "Acme Edge Device");
    const cr = (
      await app.inject({
        method: "POST",
        url: "/api/v1/specs/review",
        payload: { spec_id: spec.id, proposed_content: "# v2\n", version_delta: "patch", proposed_by: "j" },
      })
    ).json();
    expect(fetchMock).not.toHaveBeenCalled(); // only subscribed to review.approved

    await app.inject({ method: "POST", url: `/api/v1/reviews/${cr.id}/approve`, payload: { reviewed_by: "r" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/x");
    const payload = JSON.parse(init.body);
    expect(payload.event).toBe("review.approved");
    expect(payload.data.version).toBe("1.0.1");
  });
});

describe("git push-back", () => {
  it("queues sync jobs on approval for subscribed repos", async () => {
    const types = await getJson("/api/v1/project-types");
    const edge = types.find((t: any) => t.name === "Acme Edge Device");
    await app.inject({
      method: "POST",
      url: "/api/v1/subscriptions",
      payload: { project_type_id: edge.id, repo: "joeldg/edge-firmware" },
    });

    const spec = await findSpec("STRUCTURE.md", "Acme Edge Device");
    const cr = (
      await app.inject({
        method: "POST",
        url: "/api/v1/specs/review",
        payload: { spec_id: spec.id, proposed_content: "# v2\n", version_delta: "minor", proposed_by: "j" },
      })
    ).json();
    await app.inject({ method: "POST", url: `/api/v1/reviews/${cr.id}/approve`, payload: { reviewed_by: "r" } });

    const jobs = await getJson("/api/v1/sync-jobs");
    expect(jobs.length).toBe(1);
    expect(jobs[0].status).toBe("pending");
    expect(jobs[0].repo).toBe("joeldg/edge-firmware");
    expect(jobs[0].version).toBe("1.1.0");
  });

  it("global spec approval fans out to all subscriptions", async () => {
    const types = await getJson("/api/v1/project-types");
    for (const name of ["Acme Edge Device", "Web App Standard"]) {
      const t = types.find((x: any) => x.name === name);
      await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        payload: { project_type_id: t.id, repo: `joeldg/${name.replace(/\W+/g, "-").toLowerCase()}` },
      });
    }
    const spec = await findSpec("GLOBAL_SECURITY.md", "Global");
    const cr = (
      await app.inject({
        method: "POST",
        url: "/api/v1/specs/review",
        payload: { spec_id: spec.id, proposed_content: "# v2\n", version_delta: "major", proposed_by: "j" },
      })
    ).json();
    await app.inject({ method: "POST", url: `/api/v1/reviews/${cr.id}/approve`, payload: { reviewed_by: "r" } });
    const jobs = await getJson("/api/v1/sync-jobs");
    expect(jobs.length).toBe(2);
  });
});

describe("AI draft-fix", () => {
  it("returns 503 without a configured LLM provider", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    const previousProvider = process.env.LLM_PROVIDER;
    const previousBase = process.env.LLM_BASE_URL;
    const previousKey = process.env.LLM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    try {
      const specs = await getJson("/api/v1/specs");
      const fb = (
        await app.inject({
          method: "POST",
          url: "/api/v1/ai/feedback",
          payload: {
            spec_id: specs[0].id,
            agent_identifier: "test-agent",
            error_type: "contradiction",
            description: "Conflicting guidance.",
          },
        })
      ).json();
      const res = await app.inject({ method: "POST", url: `/api/v1/ai/feedback/${fb.id}/draft-fix`, payload: {} });
      expect(res.statusCode).toBe(503);
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
      if (previousProvider !== undefined) process.env.LLM_PROVIDER = previousProvider;
      if (previousBase !== undefined) process.env.LLM_BASE_URL = previousBase;
      if (previousKey !== undefined) process.env.LLM_API_KEY = previousKey;
    }
  });
});

describe("LLM settings", () => {
  it("saves app keys without returning secret values", async () => {
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/app-keys",
      payload: {
        github_token: "ghp_secret",
        github_webhook_secret: "github-hook-secret",
        slack_signing_secret: "slack-secret",
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      has_github_token: true,
      has_github_webhook_secret: true,
      has_slack_signing_secret: true,
    });
    expect(saved.body).not.toContain("ghp_secret");
    expect(saved.body).not.toContain("github-hook-secret");
    expect(saved.body).not.toContain("slack-secret");

    const loaded = await app.inject({ method: "GET", url: "/api/v1/app-keys" });
    expect(loaded.json()).toEqual(saved.json());

    const cleared = await app.inject({
      method: "PUT",
      url: "/api/v1/app-keys",
      payload: { clear_slack_signing_secret: true },
    });
    expect(cleared.json()).toMatchObject({ has_slack_signing_secret: false });
  });

  it("saves OpenAI-compatible local provider settings and tests the connection", async () => {
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/llm/config",
      payload: {
        provider: "openai_compatible",
        model: "local-model",
        base_url: "http://llm.internal/v1",
        api_key: "local-secret",
        max_tokens: 2048,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      provider: "openai_compatible",
      model: "local-model",
      base_url: "http://llm.internal/v1",
      max_tokens: 2048,
      has_api_key: true,
    });
    expect(saved.json()).not.toHaveProperty("api_key");

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const test = await app.inject({ method: "POST", url: "/api/v1/llm/test", payload: { prompt: "ping", max_tokens: 321 } });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ ok: true, provider: "openai_compatible", model: "local-model", text: "ok", max_tokens: 321 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://llm.internal/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer local-secret" }),
        body: expect.stringContaining('"max_tokens":321'),
      })
    );
  });

  it("exposes default LLM tiers and lets feature routes pick tier-specific configs", async () => {
    const defaults = await app.inject({ method: "GET", url: "/api/v1/llm/tiering" });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().routes).toMatchObject({
      classification: "cheap",
      task_planning: "cheap",
      ticket_generation: "standard",
      spec_generation: "frontier",
      draft_fix: "frontier",
      test: "standard",
    });

    const cheap = await app.inject({
      method: "PUT",
      url: "/api/v1/llm/tiering/tier/cheap",
      payload: {
        provider: "openai_compatible",
        model: "cheap-local",
        base_url: "http://cheap-llm",
        max_tokens: 512,
        clear_api_key: true,
      },
    });
    expect(cheap.statusCode).toBe(200);
    expect(cheap.json()).toMatchObject({
      tier: "cheap",
      provider: "openai_compatible",
      model: "cheap-local",
      base_url: "http://cheap-llm",
      max_tokens: 512,
      has_api_key: false,
    });

    const frontier = await app.inject({
      method: "PUT",
      url: "/api/v1/llm/tiering/tier/frontier",
      payload: {
        provider: "openai_compatible",
        model: "frontier-local",
        base_url: "http://frontier-llm/v1",
        max_tokens: 4096,
      },
    });
    expect(frontier.statusCode).toBe(200);

    const routes = await app.inject({
      method: "PUT",
      url: "/api/v1/llm/tiering/routes",
      payload: { routes: { test: "cheap", audit: "frontier" } },
    });
    expect(routes.statusCode).toBe(200);
    expect(routes.json().routes).toMatchObject({ test: "cheap", audit: "frontier" });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "cheap ok" } }] }), {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const test = await app.inject({ method: "POST", url: "/api/v1/llm/test", payload: { prompt: "ping", route: "test" } });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({
      ok: true,
      provider: "openai_compatible",
      model: "cheap-local",
      tier: "cheap",
      route: "test",
      text: "cheap ok",
    });
    expect(fetchMock).toHaveBeenLastCalledWith("http://cheap-llm/v1/chat/completions", expect.any(Object));

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "frontier ok" } }] }), {
        headers: { "content-type": "application/json" },
      })
    );
    const audit = await app.inject({ method: "POST", url: "/api/v1/llm/test", payload: { prompt: "ping", route: "audit" } });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).toMatchObject({ model: "frontier-local", tier: "frontier", route: "audit", text: "frontier ok" });
    expect(fetchMock).toHaveBeenLastCalledWith("http://frontier-llm/v1/chat/completions", expect.any(Object));
  });

  it("loads model lists from a selected LLM tier", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/llm/tiering/tier/cheap",
      payload: { provider: "openai_compatible", base_url: "http://tier-models", model: "local-a" },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "local-a" }, { id: "local-b" }] }), {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await app.inject({ method: "GET", url: "/api/v1/llm/models/cheap" });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toEqual({ provider: "openai_compatible", models: ["local-a", "local-b"], tier: "cheap" });
    expect(fetchMock).toHaveBeenCalledWith("http://tier-models/v1/models", expect.any(Object));
  });

  it("rejects invalid LLM tier routes", async () => {
    const badTier = await app.inject({ method: "PUT", url: "/api/v1/llm/tiering/tier/turbo", payload: {} });
    expect(badTier.statusCode).toBe(400);

    const badRoute = await app.inject({
      method: "PUT",
      url: "/api/v1/llm/tiering/routes",
      payload: { routes: { imaginary: "cheap" } },
    });
    expect(badRoute.statusCode).toBe(400);
  });

  it("normalizes LM Studio root URLs and accepts local response variants", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/llm/config",
      payload: {
        provider: "openai_compatible",
        model: "google/gemma-4-12b-qat",
        base_url: "http://10.0.0.142:1234",
        max_tokens: 256,
        clear_api_key: true,
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ text: "ok from lm studio" }] }), {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const test = await app.inject({ method: "POST", url: "/api/v1/llm/test", payload: { prompt: "ping", max_tokens: 64 } });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({
      ok: true,
      provider: "openai_compatible",
      model: "google/gemma-4-12b-qat",
      text: "ok from lm studio",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://10.0.0.142:1234/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.not.objectContaining({ authorization: expect.any(String) }),
      })
    );
  });

  it("returns actionable diagnostics when a local LLM response has no text", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/llm/config",
      payload: { provider: "openai_compatible", model: "local-empty", base_url: "http://localhost:1234" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "", reasoning_content: "hidden reasoning" }, finish_reason: "stop" }] }), {
          headers: { "content-type": "application/json" },
        })
      )
    );
    const test = await app.inject({ method: "POST", url: "/api/v1/llm/test", payload: { prompt: "ping" } });
    expect(test.statusCode).toBe(502);
    expect(test.json().message).toContain("finish_reason=stop");
    expect(test.json().message).toContain("/v1");
  });

  it("lists models from OpenAI-compatible, OpenAI, and Gemini providers", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "local-a" }, { id: "local-b" }] }), {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    await app.inject({
      method: "PUT",
      url: "/api/v1/llm/config",
      payload: { provider: "openai_compatible", base_url: "http://local-llm", model: "local-a" },
    });
    const local = await app.inject({ method: "GET", url: "/api/v1/llm/models" });
    expect(local.json().models).toEqual(["local-a", "local-b"]);
    expect(fetchMock).toHaveBeenLastCalledWith("http://local-llm/v1/models", expect.any(Object));

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "gpt-a" }] }), {
        headers: { "content-type": "application/json" },
      })
    );
    await app.inject({
      method: "PUT",
      url: "/api/v1/llm/config",
      payload: { provider: "openai", base_url: "https://openai.test/v1", api_key: "openai-key", model: "gpt-a" },
    });
    const openai = await app.inject({ method: "GET", url: "/api/v1/llm/models" });
    expect(openai.json().models).toEqual(["gpt-a"]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://openai.test/v1/models",
      expect.objectContaining({ headers: { authorization: "Bearer openai-key" } })
    );

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [
            { name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] },
            { name: "models/embed-a", supportedGenerationMethods: ["embedContent"] },
          ],
        }),
        { headers: { "content-type": "application/json" } }
      )
    );
    await app.inject({
      method: "PUT",
      url: "/api/v1/llm/config",
      payload: { provider: "gemini", base_url: "https://gemini.test/v1beta", api_key: "gemini-key", model: "gemini-3.5-flash" },
    });
    const gemini = await app.inject({ method: "GET", url: "/api/v1/llm/models" });
    expect(gemini.json().models.slice(0, 4)).toEqual([
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite-preview-12-2025",
      "gemini-3-pro-preview",
      "gemini-3-pro-image-preview",
    ]);
    expect(gemini.json().models).toContain("gemini-a");
    expect(gemini.json().models).not.toContain("embed-a");
    expect(fetchMock).toHaveBeenLastCalledWith("https://gemini.test/v1beta/models?key=gemini-key");
  });

  it("lists current Gemini models without an API key", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/llm/config",
      payload: { provider: "gemini", model: "gemini-3.5-flash", clear_api_key: true },
    });
    const gemini = await app.inject({ method: "GET", url: "/api/v1/llm/models" });
    expect(gemini.json().models).toEqual([
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite-preview-12-2025",
      "gemini-3-pro-preview",
      "gemini-3-pro-image-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ]);
  });
});

describe("usage analytics", () => {
  it("records downloads and agent reads in the summary", async () => {
    await app.inject({ method: "GET", url: "/api/v1/specs/Acme%20Edge%20Device/download" });
    await app.inject({ method: "GET", url: "/api/v1/ai/specs/Web%20App%20Standard" });
    await app.inject({ method: "GET", url: "/api/v1/ai/specs/Web%20App%20Standard" });
    const summary = await getJson("/api/v1/analytics/summary");
    expect(summary.events.download).toBe(1);
    expect(summary.events.agent_read).toBe(2);
    expect(summary.top_project_types.length).toBeGreaterThan(0);
  });

  it("builds granular reports for scopes, project types, projects, and AI feedback", async () => {
    const spec = await findSpec("API.md", "Acme Edge Device");
    const feedback = await app.inject({
      method: "POST",
      url: "/api/v1/ai/feedback",
      payload: {
        spec_id: spec.id,
        spec_version: spec.current_version,
        agent_identifier: "report-test-agent",
        error_type: "ambiguity",
        description: "Report smoke test feedback",
      },
    });
    expect(feedback.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      url: "/api/v1/cli/manifest-report",
      payload: {
        repo: "github.com/acme/reporting",
        project_type: "Acme Edge Device",
        specs: [{ filename: "API.md", version: "0.9.0", project_type: "Acme Edge Device" }],
      },
    });

    const report = await getJson("/api/v1/reports/overview");
    expect(report.scopes.some((row: any) => row.scope === "global")).toBe(true);
    expect(report.feedback_by_type).toContainEqual(expect.objectContaining({ error_type: "ambiguity", status: "open", n: 1 }));
    expect(report.project_types.find((row: any) => row.name === "Acme Edge Device")).toMatchObject({
      open_feedback: 1,
      project_count: 1,
    });
    expect(report.projects.find((row: any) => row.repo === "github.com/acme/reporting")).toMatchObject({
      project_type_name: "Acme Edge Device",
      reported_specs: 1,
    });
    expect(report.global_specs.length).toBeGreaterThan(0);
  });
});

describe("governance and quality reports", () => {
  it("adds risk scoring and dry-run publish preview to change requests", async () => {
    const spec = await findSpec("API.md", "Acme Edge Device");
    const review = await app.inject({
      method: "POST",
      url: "/api/v1/specs/review",
      payload: {
        spec_id: spec.id,
        proposed_content: `${spec.content}\n\n## Security\n\nTokens must be encrypted. TBD.\n`,
        version_delta: "patch",
        proposed_by: "risk-test",
      },
    });
    expect(review.statusCode).toBe(201);
    const cr = review.json();
    expect(JSON.parse(cr.risk)).toMatchObject({ level: expect.any(String), score: expect.any(Number) });
    expect(JSON.parse(cr.lint).ambiguity_terms.length).toBeGreaterThan(0);

    const preview = await getJson(`/api/v1/reviews/${cr.id}/publish-preview`);
    expect(preview).toMatchObject({
      change_request_id: cr.id,
      filename: "API.md",
      sync_jobs_to_enqueue: expect.any(Number),
    });
    expect(preview.generated_agent_files).toContain("AGENTS.md");
    expect(preview.checks.risk.score).toBeGreaterThan(0);
    expect(preview.impact).toMatchObject({
      scope: "project_type",
      level: expect.any(String),
      score: expect.any(Number),
      feedback: { total: expect.any(Number), open: expect.any(Number) },
    });
    expect(preview.impact.summary).toContain("API.md");
    expect(preview.migration_checklist.items.length).toBeGreaterThan(0);
    expect(preview.pr_summary_markdown).toContain("## Migration checklist");
    expect(preview.pr_summary_markdown).toContain("## Changelog");
  });

  it("exposes standalone spec impact exploration with migration guidance", async () => {
    const spec = await findSpec("API.md", "Acme Edge Device");
    const res = await app.inject({ method: "GET", url: `/api/v1/specs/${spec.id}/impact?delta=major` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      spec: expect.objectContaining({ id: spec.id, filename: "API.md" }),
      impact: expect.objectContaining({ scope: "project_type", level: expect.any(String), score: expect.any(Number) }),
      migration_checklist: expect.objectContaining({ version_delta: "major", items: expect.any(Array) }),
    });
    expect(res.json().migration_checklist.items.join("\n")).toContain("breaking governance change");
    expect(res.json().pr_summary_markdown).toContain("## Changelog");
  });

  it("exposes CODEOWNERS-style ownership and a dependency map", async () => {
    const types = await getJson("/api/v1/project-types");
    const edge = types.find((t: any) => t.name === "Acme Edge Device");
    const policy = await app.inject({
      method: "POST",
      url: "/api/v1/approval-policies",
      payload: { project_type_id: edge.id, filename_glob: "API.md", min_approvals: 1, required_reviewers: ["api-owner"] },
    });
    expect(policy.statusCode).toBe(201);

    const ownership = await getJson("/api/v1/spec-ownership");
    expect(ownership.ownership.find((row: any) => row.filename === "API.md" && row.project_type_name === "Acme Edge Device")).toMatchObject({
      owners: ["api-owner"],
    });

    const depSpec = await app.inject({
      method: "POST",
      url: "/api/v1/specs",
      payload: {
        project_type_id: edge.id,
        filename: "DEPENDENCY_TEST.md",
        content: "# Dependency Test\n\nThis spec references API.md and depends on DESIGN.md.\n",
        updated_by: "dep-test",
      },
    });
    expect(depSpec.statusCode).toBe(201);
    await app.inject({ method: "POST", url: `/api/v1/specs/${depSpec.json().id}/publish`, payload: { published_by: "dep-test" } });
    const map = await getJson("/api/v1/specs/dependency-map");
    expect(map.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from_filename: "DEPENDENCY_TEST.md", to_filename: "API.md" })]));
  });
});

describe("AI feedback governance", () => {
  it("supports cluster status actions and token ROI/trend reports", async () => {
    const spec = await findSpec("API.md", "Acme Edge Device");
    for (const agent of ["agent-a", "agent-b"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/ai/feedback",
        payload: {
          spec_id: spec.id,
          spec_version: spec.current_version,
          agent_identifier: agent,
          error_type: "ambiguity",
          description: "Authentication timeout guidance is ambiguous",
        },
      });
      expect(res.statusCode).toBe(201);
    }
    const clusters = await getJson("/api/v1/ai/feedback/clusters?status=open");
    const cluster = clusters.find((row: any) => row.count === 2);
    expect(cluster).toBeTruthy();

    const updated = await app.inject({
      method: "POST",
      url: "/api/v1/ai/feedback/clusters/status",
      payload: { key: cluster.key, status: "acknowledged" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ updated: 2, status: "acknowledged" });

    const roi = await getJson("/api/v1/ai/token-roi");
    expect(roi.specs.find((row: any) => row.filename === "API.md")).toMatchObject({ approx_tokens: expect.any(Number) });

    const trends = await getJson("/api/v1/ai/efficacy/trends");
    expect(trends.runs).toEqual([]);
  });
});

describe("LLM spec automation", () => {
  it("detects missing spec gaps and creates generated drafts from purpose templates", async () => {
    const purposes = await getJson("/api/v1/spec-purposes");
    expect(purposes.find((purpose: any) => purpose.id === "database-schema")).toMatchObject({
      filename: "DATABASE_SCHEMA.md",
    });

    const gaps = await app.inject({
      method: "POST",
      url: "/api/v1/spec-gaps",
      payload: {
        project_type: "Acme Edge Device",
        tree: "src/routes/api.ts\nsrc/db/schema.sql\nsrc/auth/session.ts\ntests/api.test.ts\ndocker-compose.yml",
        detected_languages: ["TypeScript", "SQL"],
        existing_specs: ["API.md"],
      },
    });
    expect(gaps.statusCode).toBe(200);
    expect(gaps.json().gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose_id: "database-schema", filename: "DATABASE_SCHEMA.md" }),
        expect.objectContaining({ purpose_id: "security-privacy", filename: "SECURITY_PRIVACY.md" }),
      ])
    );

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/spec-generation/preview",
      payload: {
        project_type: "Acme Edge Device",
        purpose: "security-privacy",
        tree: "src/auth/session.ts\nsrc/routes/api.ts",
        detected_languages: ["TypeScript"],
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      filename: "SECURITY_PRIVACY.md",
      provider: null,
    });
    expect(preview.json().content).toContain("## AI Agent Directives");

    const draft = await app.inject({
      method: "POST",
      url: "/api/v1/spec-generation/draft",
      payload: {
        project_type: "Acme Edge Device",
        purpose: "security-privacy",
        content: preview.json().content,
        updated_by: "automation-test",
      },
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json()).toMatchObject({ filename: "SECURITY_PRIVACY.md", status: "draft" });
  });

  it("plans tasks, generates checklists, classifies sections, optimizes context, and composes packs", async () => {
    const task = "Change API authentication and add observable failure handling";
    const plan = await app.inject({
      method: "POST",
      url: "/api/v1/automation/task-plan",
      payload: { project_type: "Acme Edge Device", task, tree: "src/routes/api.ts\nsrc/auth/session.ts", token_budget: 500 },
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().acceptance_criteria.length).toBeGreaterThan(0);
    expect(plan.json().context_selection.estimated_tokens).toBeLessThanOrEqual(500);

    const ticket = await app.inject({
      method: "POST",
      url: "/api/v1/automation/ticket",
      payload: { project_type: "Acme Edge Device", task },
    });
    expect(ticket.statusCode).toBe(200);
    expect(ticket.json().markdown).toContain("Implementation Checklist");

    const classifier = await app.inject({
      method: "POST",
      url: "/api/v1/automation/section-classifier",
      payload: { project_type: "Acme Edge Device" },
    });
    expect(classifier.statusCode).toBe(200);
    expect(classifier.json().sections.length).toBeGreaterThan(0);

    const budget = await app.inject({
      method: "POST",
      url: "/api/v1/automation/context-budget",
      payload: { project_type: "Acme Edge Device", task, token_budget: 300 },
    });
    expect(budget.statusCode).toBe(200);
    expect(budget.json().estimated_tokens).toBeLessThanOrEqual(300);

    const spec = await findSpec("API.md", "Acme Edge Device");
    const auditPrompt = await app.inject({
      method: "POST",
      url: "/api/v1/automation/audit-prompt",
      payload: { spec_id: spec.id },
    });
    expect(auditPrompt.statusCode).toBe(200);
    expect(auditPrompt.json().prompt).toContain("Audit an implementation");

    const auditPromptGet = await getJson(`/api/v1/automation/audit-prompt/${spec.id}`);
    expect(auditPromptGet).toMatchObject({ spec_id: spec.id, filename: "API.md" });
    expect(auditPromptGet.prompt).toContain("Audit an implementation");

    const auditPrompts = await getJson("/api/v1/automation/audit-prompts?project_type=Acme%20Edge%20Device");
    expect(auditPrompts.prompts.find((prompt: any) => prompt.filename === "API.md")).toMatchObject({
      spec_id: spec.id,
    });

    const suggestions = await app.inject({
      method: "POST",
      url: "/api/v1/automation/improvement-suggestions",
      payload: { project_type: "Acme Edge Device" },
    });
    expect(suggestions.statusCode).toBe(200);
    expect(suggestions.json().suggestions.length).toBeGreaterThan(0);

    const pack = await app.inject({
      method: "POST",
      url: "/api/v1/automation/spec-pack",
      payload: { name: "Smoke Pack", purposes: ["api-contract", "test-strategy"] },
    });
    expect(pack.statusCode).toBe(200);
    expect(pack.json().specs.map((s: any) => s.filename)).toEqual(["API.md", "TEST_STRATEGY.md"]);
  });

  it("exposes automation flags and blocks disabled features", async () => {
    const flags = await getJson("/api/v1/automation/features");
    expect(flags.gap_detection).toBe(true);
    vi.stubEnv("SPECREG_AUTOMATION_TASK_PLANNER", "false");
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/automation/task-plan",
      payload: { project_type: "Acme Edge Device", task: "x" },
    });
    expect(blocked.statusCode).toBe(403);
  });

  it("persists feature settings and applies automation overrides", async () => {
    const initial = await getJson("/api/v1/features/config");
    expect(initial.code_metadata.typescript_javascript).toBe(true);
    expect(initial.catalog.code_metadata.find((feature: any) => feature.key === "traceability_graph")).toMatchObject({
      stage: "available",
    });
    expect(initial.code_metadata.traceability_graph).toBe(true);
    const enabled = await app.inject({
      method: "PUT",
      url: "/api/v1/features/config",
      payload: { automation: { task_planner: true } },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().automation.task_planner).toBe(true);

    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/features/config",
      payload: {
        automation: { task_planner: false },
        code_metadata: { python: false, coverage_reports: false },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().automation.task_planner).toBe(false);
    expect(saved.json().code_metadata.python).toBe(false);

    const flags = await getJson("/api/v1/automation/features");
    expect(flags.task_planner).toBe(false);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/automation/task-plan",
      payload: { project_type: "Acme Edge Device", task: "x" },
    });
    expect(blocked.statusCode).toBe(403);

    const restored = await app.inject({
      method: "PUT",
      url: "/api/v1/features/config",
      payload: { automation: { task_planner: true } },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().automation.task_planner).toBe(true);
  });
});

describe("resolve-guidance (on-demand styleguide/spec acquisition)", () => {
  it("returns a pullable styleguide for a covered language", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/resolve-guidance",
      payload: { project_type: "Acme Edge Device", languages: ["Go"] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.covered).toBe(true);
    expect(body.styleguides).toEqual([
      expect.objectContaining({ id: "go", pull_command: "specreg styleguide add go" }),
    ]);
    expect(body.gaps).toEqual([]);
  });

  it("reports a gap for a language with no styleguide", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/resolve-guidance",
      payload: { project_type: "Acme Edge Device", languages: ["Rust"] },
    });
    const body = res.json();
    expect(body.covered).toBe(false);
    expect(body.styleguides).toEqual([]);
    expect(body.gaps).toEqual([
      expect.objectContaining({ kind: "styleguide", subject: "Rust" }),
    ]);
  });

  it("resolves a governed spec for a covered topic", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/resolve-guidance",
      payload: { project_type: "Acme Edge Device", topic: "firewall" },
    });
    const body = res.json();
    expect(body.specs.length).toBeGreaterThan(0);
    expect(body.specs.some((s: any) => s.filename === "GLOBAL_SECURITY.md")).toBe(true);
    expect(body.covered).toBe(true);
  });

  it("resolves agent governance review topics to the baseline agent operating spec", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/resolve-guidance",
      payload: { project_type: "Acme Edge Device", topic: "agent operating requirements and governance review" },
    });
    const body = res.json();
    expect(body.covered).toBe(true);
    expect(body.gaps).toEqual([]);
    expect(body.specs.some((s: any) => s.filename === "AGENT_OPERATING_RULES.md")).toBe(true);
  });

  it("reports a spec gap for an uncovered topic", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/resolve-guidance",
      payload: { project_type: "Acme Edge Device", topic: "quantum teleportation choreography" },
    });
    const body = res.json();
    expect(body.specs).toEqual([]);
    expect(body.gaps.some((g: any) => g.kind === "spec")).toBe(true);
    expect(body.covered).toBe(false);
  });

  it("requires at least one of languages or topic", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/resolve-guidance",
      payload: { project_type: "Acme Edge Device" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("compliance verification loop", () => {
  const compliantTrace = {
    schema_version: 1,
    coverage: { governed_entity_count: 10, linked_entity_count: 10, unlinked_entity_count: 0, coverage_ratio: 1, unlinked_by_kind: {} },
    drift: { score: 0, severity: "none" },
  };
  const failingTrace = {
    schema_version: 1,
    coverage: { governed_entity_count: 16, linked_entity_count: 3, unlinked_entity_count: 13, coverage_ratio: 0.19, unlinked_by_kind: { route: 2, schema: 1, function: 10 } },
    drift: { score: 0.81, severity: "high" },
  };

  it("passes when coverage/drift meet the policy", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/compliance-check",
      payload: { project_type: "Acme Edge Device", repo: "github.com/acme/ok", trace: compliantTrace, self_assessed_score: 100 },
    });
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v.compliant).toBe(true);
    expect(v.outstanding).toEqual([]);
    expect(v.directive).toMatch(/COMPLIANT/);
  });

  it("fails with concrete outstanding items and a keep-working directive", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/compliance-check",
      payload: { project_type: "Acme Edge Device", repo: "github.com/acme/bad", trace: failingTrace, self_assessed_score: 100 },
    });
    const v = res.json();
    expect(v.compliant).toBe(false);
    expect(v.over_claimed).toBe(true); // self 100 vs low objective
    const checks = v.outstanding.map((o: any) => o.check).sort();
    expect(checks).toEqual(["coverage", "drift", "mapping", "mapping"].sort());
    expect(v.directive).toMatch(/NOT COMPLIANT/);
    expect(v.directive).toMatch(/self-assessed 100/);
  });

  it("flags missing trace data", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/compliance-check",
      payload: { project_type: "Acme Edge Device", repo: "github.com/acme/notrace" },
    });
    const v = res.json();
    expect(v.compliant).toBe(false);
    expect(v.outstanding[0].check).toBe("trace");
    expect(v.objective_score).toBe(0);
  });

  it("records attestations and increments the iteration counter", async () => {
    const repo = "github.com/acme/loop";
    await app.inject({ method: "POST", url: "/api/v1/ai/compliance-check", payload: { project_type: "Acme Edge Device", repo, trace: failingTrace } });
    const second = await app.inject({ method: "POST", url: "/api/v1/ai/compliance-check", payload: { project_type: "Acme Edge Device", repo, trace: compliantTrace } });
    expect(second.json().iteration).toBe(2);
    const log = await getJson(`/api/v1/compliance-attestations?repo=${encodeURIComponent(repo)}`);
    expect(log.length).toBe(2);
  });

  it("honors an admin-tightened per-project-type policy", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/v1/compliance-policies",
      payload: { project_type: "Acme Edge Device", min_coverage: 1.0, max_drift: 0, required_mapped_kinds: ["route", "schema"] },
    });
    // coverage_ratio 1 but drift 0 trace passes; a 0.95-coverage trace now fails
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/compliance-check",
      payload: {
        project_type: "Acme Edge Device",
        repo: "github.com/acme/strict",
        trace: { schema_version: 1, coverage: { coverage_ratio: 0.95, unlinked_by_kind: {} }, drift: { score: 0, severity: "none" } },
      },
    });
    expect(res.json().compliant).toBe(false);
    expect(res.json().outstanding.some((o: any) => o.check === "coverage")).toBe(true);
  });
});

describe("agent lifecycle control plane", () => {
  const compliantTrace = {
    schema_version: 1,
    coverage: { governed_entity_count: 8, linked_entity_count: 8, unlinked_entity_count: 0, coverage_ratio: 1, unlinked_by_kind: {} },
    drift: { score: 0, severity: "none" },
  };

  it("registers a preflight session with the governed spec bundle", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/agent-sessions/begin",
      payload: {
        project_type: "Acme Edge Device",
        repo: "github.com/acme/lifecycle",
        task: "Add governed lifecycle controls",
        plan: "Load specs, implement controls, verify.",
        model: "test-model",
        specs_loaded: ["GLOBAL_SECURITY.md"],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.session_id).toMatch(/[0-9a-f-]{36}/);
    expect(body.status).toBe("ready");
    expect(body.specs.length).toBeGreaterThan(0);
    expect(body.required_finish_tool).toBe("finish_task");

    const sessions = await getJson("/api/v1/ai/agent-sessions?repo=github.com/acme/lifecycle");
    expect(sessions[0]).toMatchObject({
      id: body.session_id,
      status: "active",
      task: "Add governed lifecycle controls",
      model: "test-model",
      repo: "github.com/acme/lifecycle",
    });
    expect(sessions[0].spec_bundle.length).toBeGreaterThan(0);
  });

  it("blocks finish until objective compliance passes, then completes the session", async () => {
    const begin = await app.inject({
      method: "POST",
      url: "/api/v1/ai/agent-sessions/begin",
      payload: {
        project_type: "Acme Edge Device",
        repo: "github.com/acme/finish-loop",
        task: "Finish through objective gate",
        specs_loaded: ["GLOBAL_SECURITY.md"],
      },
    });
    const sessionId = begin.json().session_id;

    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/ai/agent-sessions/finish",
      payload: {
        session_id: sessionId,
        summary: "Tried to finish without trace.",
        self_assessed_score: 100,
        tests: ["npm test"],
      },
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json().status).toBe("blocked");
    expect(blocked.json().compliant).toBe(false);
    expect(blocked.json().directive).toMatch(/COMPLETION BLOCKED/);

    const completed = await app.inject({
      method: "POST",
      url: "/api/v1/ai/agent-sessions/finish",
      payload: {
        session_id: sessionId,
        summary: "Trace is now mapped.",
        self_assessed_score: 100,
        changed_files: ["packages/server/src/routes/feedback.ts"],
        trace: compliantTrace,
      },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("completed");
    expect(completed.json().compliant).toBe(true);

    // Agent-tier listing is repo-scoped; the cross-repo view is admin-only.
    const sessions = await getJson("/api/v1/ai/agent-sessions?repo=github.com/acme/finish-loop&status=completed");
    const session = sessions.find((row: any) => row.id === sessionId);
    expect(session.completion_summary.summary).toBe("Trace is now mapped.");
    expect(session.compliance_attestation_id).toMatch(/[0-9a-f-]{36}/);

    // Cross-repo view works on the admin route.
    const all = await getJson("/api/v1/agent-sessions?status=completed");
    expect(all.some((row: any) => row.id === sessionId)).toBe(true);
  });

  it("requires a repo to list agent sessions on the agent-tier route", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/ai/agent-sessions" });
    expect(res.statusCode).toBe(400);
  });
});
