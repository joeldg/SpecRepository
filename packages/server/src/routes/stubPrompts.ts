import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Spec, StubPrompt, StubPromptResponse, SyncCheckResponse } from "@specregistry/shared";
import { findProjectConsumer, HttpError, requireProjectType, requireString } from "../helpers.js";
import { recordUsage } from "../lib/events.js";
import { now, uuid } from "../db.js";
import { diagnoseManifest } from "../lib/manifestDiagnostics.js";

interface CodeTracePayload {
  schema_version?: unknown;
  generated_at?: unknown;
  specs_dir?: unknown;
  spec_count?: unknown;
  entity_count?: unknown;
  links?: unknown;
  unlinked_entities?: unknown;
  aliases?: unknown;
  coverage?: {
    governed_entity_count?: unknown;
    linked_entity_count?: unknown;
    unlinked_entity_count?: unknown;
    coverage_ratio?: unknown;
  };
  drift?: {
    score?: unknown;
    severity?: unknown;
  };
}

function numberValue(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function ensureConsumer(app: FastifyInstance, input: Record<string, unknown>, projectTypeId: string): string {
  const repo = requireString(input, "repo");
  const ts = now();
  const existing = app.db
    .prepare("SELECT id, first_seen_at FROM repo_consumers WHERE repo = ? AND project_type_id = ?")
    .get(repo, projectTypeId) as { id: string; first_seen_at: string } | undefined;
  const requested = typeof input.project_id === "string" ? findProjectConsumer(app.db, input.project_id, projectTypeId) : undefined;
  const id = requested?.id ?? existing?.id ?? uuid();
  app.db
    .prepare(
      `INSERT OR REPLACE INTO repo_consumers
       (id, repo, branch, commit_sha, project_type_id, specs_path, manifest_path, source, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      repo,
      typeof input.branch === "string" ? input.branch : null,
      typeof input.commit_sha === "string" ? input.commit_sha : null,
      projectTypeId,
      typeof input.specs_path === "string" ? input.specs_path : "specs",
      typeof input.manifest_path === "string" ? input.manifest_path : "specs/.specregistry.json",
      typeof input.source === "string" ? input.source : "cli",
      existing?.first_seen_at ?? ts,
      ts
    );
  return id;
}

export async function stubPromptRoutes(app: FastifyInstance): Promise<void> {
  app.get("/cli/download", async (req, reply) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "../../../..");
    const tgzPath = path.resolve(repoRoot, "specregistry-cli-0.1.0.tgz");
    if (!fs.existsSync(tgzPath)) {
      throw new HttpError(404, "CLI tarball not found. Please build and pack it on the server first.");
    }
    const stream = fs.createReadStream(tgzPath);
    reply.header("content-type", "application/gzip");
    reply.header("content-disposition", "attachment; filename=specregistry-cli-0.1.0.tgz");
    return reply.send(stream);
  });

  app.post("/cli/manifest-report", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pt = requireProjectType(app.db, requireString(body, "project_type"));
    const project =
      typeof body.project_id === "string"
        ? findProjectConsumer(app.db, body.project_id, pt.id)
        : typeof body.repo === "string"
          ? findProjectConsumer(app.db, body.repo, pt.id)
          : undefined;
    const repo = requireString(body, "repo");
    const specs = Array.isArray(body.specs)
      ? (body.specs as Array<{ filename?: unknown; version?: unknown; project_type?: unknown; sha256?: unknown }>).filter(
          (s) => typeof s?.filename === "string" && typeof s?.version === "string"
        )
      : [];
    const ts = now();
    const existing = app.db
      .prepare("SELECT id, first_seen_at FROM repo_consumers WHERE repo = ? AND project_type_id = ?")
      .get(repo, pt.id) as { id: string; first_seen_at: string } | undefined;
    const id = existing?.id ?? uuid();
    app.db.transaction(() => {
      app.db
        .prepare(
          `INSERT OR REPLACE INTO repo_consumers
           (id, repo, branch, commit_sha, project_type_id, specs_path, manifest_path, source, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          repo,
          typeof body.branch === "string" ? body.branch : null,
          typeof body.commit_sha === "string" ? body.commit_sha : null,
          pt.id,
          typeof body.specs_path === "string" ? body.specs_path : "specs",
          typeof body.manifest_path === "string" ? body.manifest_path : "specs/.specregistry.json",
          typeof body.source === "string" ? body.source : "cli",
          existing?.first_seen_at ?? ts,
          ts
        );
      app.db.prepare("DELETE FROM repo_consumer_specs WHERE consumer_id = ?").run(id);
      const insert = app.db.prepare(
        `INSERT INTO repo_consumer_specs (consumer_id, filename, version, project_type, sha256, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const spec of specs) {
        insert.run(
          id,
          spec.filename,
          spec.version,
          typeof spec.project_type === "string" ? spec.project_type : null,
          typeof spec.sha256 === "string" ? spec.sha256 : null,
          ts
        );
      }
    })();
    recordUsage(app.db, "sync_check", pt.id, `manifest:${repo}`);
    return { ok: true, project_id: id, repo, project_type: pt.name, specs: specs.length, last_seen_at: ts };
  });

  app.post("/cli/code-trace-report", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pt = requireProjectType(app.db, requireString(body, "project_type"));
    const trace = (typeof body.trace === "object" && body.trace !== null ? body.trace : body) as CodeTracePayload;
    const links = Array.isArray(trace.links) ? trace.links.slice(0, 500) as Array<Record<string, unknown>> : [];
    const unlinked = Array.isArray(trace.unlinked_entities) ? trace.unlinked_entities.slice(0, 50) : [];
    const aliases = Array.isArray(trace.aliases) ? trace.aliases : [];
    const ts = now();
    const reportId = uuid();
    const consumerId = app.db.transaction(() => {
      const id = ensureConsumer(app, body, pt.id);
      app.db
        .prepare(
          `INSERT INTO code_trace_reports
           (id, consumer_id, generated_at, specs_dir, spec_count, entity_count,
            governed_entity_count, linked_entity_count, unlinked_entity_count,
            coverage_ratio, drift_score, drift_severity, aliases_count,
            unlinked_sample, raw_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          reportId,
          id,
          stringValue(trace.generated_at, ts),
          stringValue(trace.specs_dir, "specs"),
          numberValue(trace.spec_count),
          numberValue(trace.entity_count),
          numberValue(trace.coverage?.governed_entity_count),
          numberValue(trace.coverage?.linked_entity_count),
          numberValue(trace.coverage?.unlinked_entity_count),
          numberValue(trace.coverage?.coverage_ratio),
          numberValue(trace.drift?.score),
          stringValue(trace.drift?.severity, "none"),
          aliases.length,
          JSON.stringify(unlinked),
          JSON.stringify(trace),
          ts
        );
      const insertLink = app.db.prepare(
        `INSERT OR REPLACE INTO code_trace_links
         (report_id, entity_id, entity_name, entity_kind, spec_filename, confidence, reasons)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const link of links) {
        if (typeof link.entity_id !== "string" || typeof link.spec_filename !== "string") continue;
        insertLink.run(
          reportId,
          link.entity_id,
          stringValue(link.entity_name),
          stringValue(link.entity_kind),
          link.spec_filename,
          numberValue(link.confidence),
          JSON.stringify(Array.isArray(link.reasons) ? link.reasons : [])
        );
      }
      return id;
    })();
    recordUsage(app.db, "sync_check", pt.id, `code-trace:${requireString(body, "repo")}`);
    return {
      ok: true,
      report_id: reportId,
      project_id: consumerId,
      repo: requireString(body, "repo"),
      project_type: pt.name,
      coverage_ratio: numberValue(trace.coverage?.coverage_ratio),
      drift_score: numberValue(trace.drift?.score),
      drift_severity: stringValue(trace.drift?.severity, "none"),
      links: links.length,
      created_at: ts,
    };
  });

  app.get("/cli/consumers", async () => {
    const rows = app.db
      .prepare(
        `SELECT rc.*, pt.name AS project_type_name,
                COUNT(rcs.filename) AS spec_count,
                SUM(CASE WHEN s.current_version IS NOT NULL AND s.current_version != rcs.version THEN 1 ELSE 0 END) AS outdated_count
         FROM repo_consumers rc
         JOIN project_types pt ON pt.id = rc.project_type_id
         LEFT JOIN repo_consumer_specs rcs ON rcs.consumer_id = rc.id
         LEFT JOIN specs s ON s.filename = rcs.filename
          AND s.status = 'published'
          AND s.deleted_at IS NULL
          AND (s.project_id = rc.id OR (s.project_id IS NULL AND (s.project_type_id = rc.project_type_id OR s.project_type_id IN (SELECT id FROM project_types WHERE scope = 'global'))))
         GROUP BY rc.id
         ORDER BY rc.last_seen_at DESC`
      )
      .all() as Array<Record<string, unknown>>;
    return rows;
  });

  // Drift detection for `specreg sync` / `specreg check --ci`.
  app.post("/cli/sync-check", async (req): Promise<SyncCheckResponse> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pt = requireProjectType(app.db, requireString(body, "project_type"));
    const local = Array.isArray(body.specs)
      ? (body.specs as Array<{ filename: string; version: string; pin?: string }>).filter(
          (s) => typeof s?.filename === "string" && typeof s?.version === "string"
        )
      : [];
    recordUsage(app.db, "sync_check", pt.id);
    return diagnoseManifest(app.db, {
      project_type: pt.name,
      repo: typeof body.repo === "string" ? body.repo : undefined,
      project_id: typeof body.project_id === "string" ? body.project_id : undefined,
      specs: local,
    });
  });

  app.post("/cli/manifest-diagnostics", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const manifest = typeof body.manifest === "object" && body.manifest !== null ? body.manifest as Record<string, unknown> : body;
    const projectType = typeof body.project_type === "string"
      ? body.project_type
      : typeof manifest.project_type === "string"
        ? manifest.project_type
        : requireString(body, "project_type");
    const specs = Array.isArray(manifest.specs)
      ? (manifest.specs as Array<{ filename?: unknown; version?: unknown; pin?: unknown; project_type?: unknown; scope?: unknown; sha256?: unknown }>).filter(
          (s) => typeof s?.filename === "string" && typeof s?.version === "string"
        ).map((s) => ({
          filename: s.filename as string,
          version: s.version as string,
          pin: typeof s.pin === "string" ? s.pin : undefined,
          project_type: typeof s.project_type === "string" ? s.project_type : undefined,
          scope: typeof s.scope === "string" ? s.scope : undefined,
          sha256: typeof s.sha256 === "string" ? s.sha256 : undefined,
        }))
      : [];
    const diagnostics = diagnoseManifest(app.db, {
      project_type: projectType,
      repo: typeof body.repo === "string" ? body.repo : typeof manifest.project === "string" ? manifest.project : undefined,
      project_id: typeof body.project_id === "string" ? body.project_id : undefined,
      specs,
    });
    recordUsage(app.db, "sync_check", diagnostics.project_type_id, `diagnostics:${diagnostics.project ?? "pasted-manifest"}`);
    return diagnostics;
  });
  // Tailored LLM prompts for generating missing spec files from an existing codebase.
  app.post("/cli/stub-prompts", async (req): Promise<StubPromptResponse> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectTypeName = requireString(body, "project_type");
    const detectedLanguages = Array.isArray(body.detected_languages)
      ? (body.detected_languages as string[]).filter((l) => typeof l === "string")
      : [];
    const pt = requireProjectType(app.db, projectTypeName);
    recordUsage(app.db, "stub_prompts", pt.id);

    // Type-specific stubs override the global (project_type_id IS NULL) defaults.
    const stubs = app.db
      .prepare(
        `SELECT * FROM stub_prompts
         WHERE project_type_id = ? OR project_type_id IS NULL
         ORDER BY target_filename, project_type_id IS NULL`
      )
      .all(pt.id) as StubPrompt[];
    const byTarget = new Map<string, StubPrompt>();
    for (const stub of stubs) {
      if (!byTarget.has(stub.target_filename)) byTarget.set(stub.target_filename, stub);
    }

    const languages = detectedLanguages.length > 0 ? detectedLanguages.join(", ") : "unknown";
    return {
      project_type: pt.name,
      prompts: [...byTarget.values()].map((stub) => ({
        target_filename: stub.target_filename,
        prompt: stub.template
          .replaceAll("[PROJECT_TYPE]", pt.name)
          .replaceAll("[LANGUAGES]", languages),
      })),
    };
  });
}
