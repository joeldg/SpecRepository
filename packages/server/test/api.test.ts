import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import AdmZip from "adm-zip";
import { createDb } from "../src/db.js";
import { seed, SPECREGISTRY_BASELINE_REQUIRED_SECTIONS, SPECREGISTRY_OPERATING_BASELINE_FILENAMES } from "../src/seed.js";
import { buildAdminTestApp } from "./helpers.js";

let app: FastifyInstance;

beforeEach(async () => {
  const db = createDb(":memory:");
  seed(db);
  app = await buildAdminTestApp(db);
});

afterEach(async () => {
  await app.close();
});

async function getJson(url: string) {
  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("project types & specs", () => {
  it("lists seeded project types with the global scope first", async () => {
    const types = await getJson("/api/v1/project-types");
    expect(types.length).toBe(11);
    expect(types[0].scope).toBe("global");
    expect(types.map((t: any) => t.name)).toContain("Acme Edge Device");
    expect(types.map((t: any) => t.name)).toEqual(
      expect.arrayContaining([
        "MCP Server / Agent Integration",
        "SaaS Backend API",
        "CLI Tool / Developer Tooling",
        "AI-SDD Governed Project",
        "Data Platform / ETL Pipeline",
        "Internal Admin Tool",
        "Mobile App",
      ])
    );
  });

  it("lists all specs as summaries with counts", async () => {
    const specs = await getJson("/api/v1/specs");
    expect(specs.length).toBe(10 + SPECREGISTRY_OPERATING_BASELINE_FILENAMES.length);
    expect(specs[0]).not.toHaveProperty("content");
    expect(specs[0]).toHaveProperty("open_feedback_count");
  });

  it("gives Web App Standard an API contract spec so new routes have something to trace against", async () => {
    const specs = await getJson("/api/v1/specs");
    const summary = specs.find(
      (s: any) => s.filename === "API_ENDPOINTS.md" && s.project_type_name === "Web App Standard"
    );
    expect(summary).toBeTruthy();
    expect(summary.status).toBe("published");
    const spec = await getJson(`/api/v1/specs/${summary.id}`);
    expect(spec.content).toContain("## Endpoints");
  });

  it("seeds the SpecRegistry operating baseline with strict SDD sections", async () => {
    const specs = await getJson("/api/v1/specs");
    const baseline = specs.filter((s: any) => SPECREGISTRY_OPERATING_BASELINE_FILENAMES.includes(s.filename));
    expect(baseline.map((s: any) => s.filename).sort()).toEqual([...SPECREGISTRY_OPERATING_BASELINE_FILENAMES].sort());
    for (const summary of baseline) {
      const detail = await getJson(`/api/v1/specs/${summary.id}`);
      for (const section of SPECREGISTRY_BASELINE_REQUIRED_SECTIONS) {
        expect(detail.content).toContain(`## ${section}`);
      }
      expect(detail.content).toContain("## AI Agent Directives");
      expect(detail.content).toMatch(/Token Budget Class/);
      expect(detail.audit_prompt).toContain("Audit an implementation");
    }
  });

  it("creates, edits, and publishes a draft spec", async () => {
    const types = await getJson("/api/v1/project-types");
    const webType = types.find((t: any) => t.name === "Web App Standard");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/specs",
      payload: {
        project_type_id: webType.id,
        filename: "API.md",
        content: "# Web API Standard\nDraft.",
        updated_by: "joel",
      },
    });
    expect(created.statusCode).toBe(201);
    const spec = created.json();
    expect(spec.status).toBe("draft");
    expect(spec.current_version).toBe("0.1.0");

    const edited = await app.inject({
      method: "PUT",
      url: `/api/v1/specs/${spec.id}`,
      payload: { content: "# Web API Standard\nv1 ready.", updated_by: "joel" },
    });
    expect(edited.statusCode).toBe(200);

    const published = await app.inject({
      method: "POST",
      url: `/api/v1/specs/${spec.id}/publish`,
      payload: { published_by: "joel" },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().current_version).toBe("1.0.0");
    expect(published.json().status).toBe("published");
  });

  it("rejects duplicate filenames within a project type", async () => {
    const types = await getJson("/api/v1/project-types");
    const edge = types.find((t: any) => t.name === "Acme Edge Device");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/specs",
      payload: { project_type_id: edge.id, filename: "DESIGN.md", content: "x", updated_by: "joel" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("soft-deletes specs, hides them from governed reads, and restores them", async () => {
    const types = await getJson("/api/v1/project-types");
    const web = types.find((t: any) => t.name === "Web App Standard");
    const spec = (await getJson(`/api/v1/specs?project_type_id=${web.id}`)).find((s: any) => s.filename === "STRUCTURE.md");

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/specs/${spec.id}`,
      payload: { confirm: true },
    });
    expect(removed.statusCode).toBe(204);

    const scoped = await getJson(`/api/v1/specs?project_type_id=${web.id}`);
    expect(scoped.some((s: any) => s.id === spec.id)).toBe(false);
    expect((await getJson("/api/v1/specs/deleted")).map((s: any) => s.id)).toContain(spec.id);
    expect((await app.inject({ method: "GET", url: `/api/v1/specs/${spec.id}` })).statusCode).toBe(404);

    const download = await app.inject({ method: "GET", url: "/api/v1/specs/Web%20App%20Standard/download" });
    const zip = new AdmZip(download.rawPayload);
    expect(zip.getEntry("STRUCTURE.md")).toBeNull();

    const search = await getJson("/api/v1/ai/search?q=Repository%20Structure&project_type=Web%20App%20Standard");
    expect(search.results.some((row: any) => row.spec_id === spec.id)).toBe(false);

    const restored = await app.inject({ method: "POST", url: `/api/v1/specs/${spec.id}/restore` });
    expect(restored.statusCode).toBe(200);
    expect((await getJson(`/api/v1/specs?project_type_id=${web.id}`)).some((s: any) => s.id === spec.id)).toBe(true);
  });

  it("keeps a soft-deleted spec filename reserved during retention", async () => {
    const types = await getJson("/api/v1/project-types");
    const web = types.find((t: any) => t.name === "Web App Standard");
    const spec = (await getJson(`/api/v1/specs?project_type_id=${web.id}`)).find((s: any) => s.filename === "STRUCTURE.md");

    await app.inject({ method: "DELETE", url: `/api/v1/specs/${spec.id}`, payload: { confirm: true } });
    const replacement = await app.inject({
      method: "POST",
      url: "/api/v1/specs",
      payload: {
        project_type_id: web.id,
        filename: "STRUCTURE.md",
        content: "# Replacement\n",
        updated_by: "admin",
      },
    });
    expect(replacement.statusCode).toBe(409);
  });
});

describe("observability", () => {
  it("exposes Prometheus metrics for SDD operations", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("# HELP specregistry_specs_total");
    expect(res.body).toContain('specregistry_specs_total{status="published",scope="global"}');
    expect(res.body).toContain("# TYPE specregistry_usage_events_total counter");
    expect(res.body).toContain('specregistry_users_total{role="admin",source="local"} 1');
    expect(res.body).toContain("specregistry_oldest_pending_review_age_seconds");
  });
});

describe("review workflow", () => {
  async function firstSpec(filename = "DESIGN.md", typeName = "Acme Edge Device") {
    const specs = await getJson("/api/v1/specs");
    return specs.find((s: any) => s.filename === filename && s.project_type_name === typeName);
  }

  it("submits a change request, generates a diff, and approves with a minor bump", async () => {
    const spec = await firstSpec();
    const submitted = await app.inject({
      method: "POST",
      url: "/api/v1/specs/review",
      payload: {
        spec_id: spec.id,
        proposed_content: "# Acme Edge Device — Design Specification\n\nRewritten guidance.\n",
        version_delta: "minor",
        proposed_by: "joel",
        summary: "Simplify design doc",
      },
    });
    expect(submitted.statusCode).toBe(201);
    const cr = submitted.json();
    expect(cr.status).toBe("pending");
    expect(cr.diff).toContain("DESIGN.md@1.0.0");
    expect(cr.diff).toContain("+Rewritten guidance.");

    const pendingSpec = await getJson(`/api/v1/specs/${spec.id}`);
    expect(pendingSpec.status).toBe("pending_review");

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/reviews/${cr.id}/approve`,
      payload: { reviewed_by: "reviewer-1" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().resulting_version).toBe("1.1.0");

    const updated = await getJson(`/api/v1/specs/${spec.id}`);
    expect(updated.current_version).toBe("1.1.0");
    expect(updated.status).toBe("published");
    expect(updated.content).toContain("Rewritten guidance.");
    expect(updated.versions.map((v: any) => v.version)).toEqual(["1.1.0", "1.0.0"]);
  });

  it("rejects a change request and restores published status", async () => {
    const spec = await firstSpec("STRUCTURE.md");
    const cr = (
      await app.inject({
        method: "POST",
        url: "/api/v1/specs/review",
        payload: {
          spec_id: spec.id,
          proposed_content: "# Bad change\n",
          version_delta: "major",
          proposed_by: "joel",
        },
      })
    ).json();

    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/reviews/${cr.id}/reject`,
      payload: { reviewed_by: "reviewer-1" },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe("rejected");

    const restored = await getJson(`/api/v1/specs/${spec.id}`);
    expect(restored.status).toBe("published");
    expect(restored.current_version).toBe("1.0.0");
    expect(restored.content).not.toContain("Bad change");
  });

  it("cannot approve the same change request twice", async () => {
    const spec = await firstSpec("API.md");
    const cr = (
      await app.inject({
        method: "POST",
        url: "/api/v1/specs/review",
        payload: { spec_id: spec.id, proposed_content: "# v2\n", version_delta: "patch", proposed_by: "joel" },
      })
    ).json();
    await app.inject({ method: "POST", url: `/api/v1/reviews/${cr.id}/approve`, payload: { reviewed_by: "r" } });
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/reviews/${cr.id}/approve`,
      payload: { reviewed_by: "r" },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe("AI feedback loop", () => {
  it("ingests feedback and surfaces it as an open alert on the spec", async () => {
    const specs = await getJson("/api/v1/specs");
    const spec = specs.find((s: any) => s.filename === "GLOBAL_SECURITY.md");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/feedback",
      payload: {
        spec_id: spec.id,
        spec_version: "1.0.0",
        agent_identifier: "Codegen-Fable5-v1",
        error_type: "contradiction",
        context_code_snippet: "const x: number = 1.5;",
        description: "Spec requires integer but architecture requires float.",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("open");

    const open = await getJson("/api/v1/ai/feedback?status=open");
    expect(open.length).toBe(1);
    expect(open[0].filename).toBe("GLOBAL_SECURITY.md");

    const summaries = await getJson("/api/v1/specs");
    const flagged = summaries.find((s: any) => s.id === spec.id);
    expect(flagged.open_feedback_count).toBe(1);
  });

  it("404s on feedback for an unknown spec and 400s on a bad error_type", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/ai/feedback",
      payload: { spec_id: "nope", agent_identifier: "a", error_type: "ambiguity", description: "d" },
    });
    expect(missing.statusCode).toBe(404);

    const specs = await getJson("/api/v1/specs");
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/ai/feedback",
      payload: { spec_id: specs[0].id, agent_identifier: "a", error_type: "vibes", description: "d" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("serves published specs (global + type) to agents", async () => {
    const res = await getJson("/api/v1/ai/specs/Acme%20Edge%20Device");
    const filenames = res.specs.map((s: any) => s.filename);
    expect(filenames).toContain("GLOBAL_SECURITY.md");
    expect(filenames).toContain("DESIGN.md");
    expect(res.specs[0]).toHaveProperty("content");
  });

  it("clusters repeated agent feedback by spec, type, and complaint text", async () => {
    const specs = await getJson("/api/v1/specs");
    const spec = specs.find((s: any) => s.filename === "GLOBAL_SECURITY.md");
    for (const agent of ["agent-a", "agent-b"]) {
      await app.inject({
        method: "POST",
        url: "/api/v1/ai/feedback",
        payload: {
          spec_id: spec.id,
          agent_identifier: agent,
          error_type: "ambiguity",
          description: "TLS firewall guidance is ambiguous for local development.",
        },
      });
    }
    const clusters = await getJson("/api/v1/ai/feedback/clusters?status=open");
    expect(clusters[0].filename).toBe("GLOBAL_SECURITY.md");
    expect(clusters[0].count).toBe(2);
    expect(clusters[0].feedback_ids.length).toBe(2);
  });
});

describe("section citations", () => {
  it("returns section anchors in agent specs and search results", async () => {
    const specs = await getJson("/api/v1/ai/specs/Acme%20Edge%20Device");
    const apiSpec = specs.specs.find((s: any) => s.filename === "API.md");
    expect(apiSpec.sections.some((section: any) => section.anchor === "transport")).toBe(true);

    const search = await getJson("/api/v1/ai/search?q=transport&project_type=Acme%20Edge%20Device");
    expect(search.results[0]).toHaveProperty("section_anchor");
    expect(search.results[0].permalink).toContain(`/api/v1/specs/${search.results[0].spec_id}#`);
  });
});

describe("CLI support endpoints", () => {
  it("returns a zip with global + project-type specs and a manifest", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/specs/Acme%20Edge%20Device/download" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    const zip = new AdmZip(res.rawPayload);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain("DESIGN.md");
    expect(names).toContain("GLOBAL_SECURITY.md");
    expect(names).toContain(".specregistry.json");
    const manifest = JSON.parse(zip.readAsText(".specregistry.json"));
    expect(manifest.project_type).toBe("Acme Edge Device");
    expect(manifest.specs.length).toBe(5 + SPECREGISTRY_OPERATING_BASELINE_FILENAMES.length);
  });

  it("substitutes project type and languages into stub prompts", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cli/stub-prompts",
      payload: { project_type: "Web App Standard", detected_languages: ["TypeScript", "CSS"] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const targets = body.prompts.map((p: any) => p.target_filename).sort();
    expect(targets).toEqual(["DESIGN.md", "STRUCTURE.md"]);
    const design = body.prompts.find((p: any) => p.target_filename === "DESIGN.md");
    expect(design.prompt).toContain('type "Web App Standard"');
    expect(design.prompt).toContain("TypeScript, CSS");
    expect(design.prompt).toContain("[CONTEXT]");
  });
});
