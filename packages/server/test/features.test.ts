import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db.js";
import { seed } from "../src/seed.js";

let app: FastifyInstance;

beforeEach(async () => {
  const db = createDb(":memory:");
  seed(db);
  app = await buildApp(db);
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

describe("sync-check (CLI drift detection)", () => {
  it("reports drift after a spec version bump", async () => {
    const clean = await app.inject({
      method: "POST",
      url: "/api/v1/cli/sync-check",
      payload: {
        project_type: "Thinkom Edge Device",
        specs: [
          { filename: "DESIGN.md", version: "1.0.0" },
          { filename: "STRUCTURE.md", version: "1.0.0" },
          { filename: "API.md", version: "1.0.0" },
          { filename: "GLOBAL_SECURITY.md", version: "1.0.0" },
          { filename: "CODING_STANDARDS.md", version: "1.0.0" },
        ],
      },
    });
    expect(clean.statusCode).toBe(200);
    expect(clean.json().drift).toBe(false);
    expect(clean.json().up_to_date.length).toBe(5);

    // Bump DESIGN.md via the review workflow
    const spec = await findSpec("DESIGN.md", "Thinkom Edge Device");
    const cr = (
      await app.inject({
        method: "POST",
        url: "/api/v1/specs/review",
        payload: {
          spec_id: spec.id,
          proposed_content: spec.filename + "\n\n# Thinkom Edge Device — Design Specification\n\n## System Architecture\nv2\n\n## Design Patterns\nv2\n\n## Data Flow\nv2\n",
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
        project_type: "Thinkom Edge Device",
        specs: [{ filename: "DESIGN.md", version: "1.0.0" }],
      },
    });
    const body = drifted.json();
    expect(body.drift).toBe(true);
    expect(body.outdated).toEqual([
      { filename: "DESIGN.md", local_version: "1.0.0", latest_version: "1.1.0" },
    ]);
    expect(body.missing_locally.length).toBe(4);
  });
});

describe("search", () => {
  it("finds sections and scopes by project type", async () => {
    const res = await getJson("/api/v1/ai/search?q=TLS%20firewall");
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].filename).toBe("GLOBAL_SECURITY.md");

    const scoped = await getJson(
      "/api/v1/ai/search?q=beam%20steering&project_type=Thinkom%20Edge%20Device"
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
});

describe("templates & lint", () => {
  it("flags missing required sections on a change request", async () => {
    const spec = await findSpec("DESIGN.md", "Thinkom Firmware");
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
      payload: { filename: "API.md", required_sections: ["Transport", "Resources"] },
    });
    expect(created.statusCode).toBe(201);
    const dup = await app.inject({
      method: "POST",
      url: "/api/v1/templates",
      payload: { filename: "api.md", required_sections: [] },
    });
    expect(dup.statusCode).toBe(409);
    const all = await getJson("/api/v1/templates");
    expect(all.length).toBe(3); // 2 seeded + API.md
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

    const spec = await findSpec("API.md", "Thinkom Edge Device");
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
    const edge = types.find((t: any) => t.name === "Thinkom Edge Device");
    await app.inject({
      method: "POST",
      url: "/api/v1/subscriptions",
      payload: { project_type_id: edge.id, repo: "joeldg/edge-firmware" },
    });

    const spec = await findSpec("STRUCTURE.md", "Thinkom Edge Device");
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
    for (const name of ["Thinkom Edge Device", "Web App Standard"]) {
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
  it("returns 503 without an Anthropic API key", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
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
    }
  });
});

describe("usage analytics", () => {
  it("records downloads and agent reads in the summary", async () => {
    await app.inject({ method: "GET", url: "/api/v1/specs/Thinkom%20Edge%20Device/download" });
    await app.inject({ method: "GET", url: "/api/v1/ai/specs/Web%20App%20Standard" });
    await app.inject({ method: "GET", url: "/api/v1/ai/specs/Web%20App%20Standard" });
    const summary = await getJson("/api/v1/analytics/summary");
    expect(summary.events.download).toBe(1);
    expect(summary.events.agent_read).toBe(2);
    expect(summary.top_project_types.length).toBeGreaterThan(0);
  });
});
