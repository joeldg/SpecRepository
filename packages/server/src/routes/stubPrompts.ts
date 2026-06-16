import type { FastifyInstance } from "fastify";
import { driftSeverity, satisfiesCaret } from "@specregistry/shared";
import type { Spec, StubPrompt, StubPromptResponse, SyncCheckResponse } from "@specregistry/shared";
import { findProjectConsumer, requireProjectType, requireString } from "../helpers.js";
import { recordUsage } from "../lib/events.js";
import { now, uuid } from "../db.js";
import { bundleSpecs } from "../lib/compile.js";

export async function stubPromptRoutes(app: FastifyInstance): Promise<void> {
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
    const project =
      typeof body.project_id === "string"
        ? findProjectConsumer(app.db, body.project_id, pt.id)
        : typeof body.repo === "string"
          ? findProjectConsumer(app.db, body.repo, pt.id)
          : undefined;
    const local = Array.isArray(body.specs)
      ? (body.specs as Array<{ filename: string; version: string; pin?: string }>).filter(
          (s) => typeof s?.filename === "string" && typeof s?.version === "string"
        )
      : [];
    recordUsage(app.db, "sync_check", pt.id);

    const latest = bundleSpecs(app.db, pt.id, "stable", project?.id);
    const latestByName = new Map(latest.map((s) => [s.filename, s.current_version]));

    const up_to_date: string[] = [];
    const outdated: SyncCheckResponse["outdated"] = [];
    const not_on_server: string[] = [];
    for (const file of local) {
      const serverVersion = latestByName.get(file.filename);
      if (serverVersion === undefined) {
        not_on_server.push(file.filename);
      } else if (serverVersion === file.version) {
        up_to_date.push(file.filename);
      } else {
        outdated.push({
          filename: file.filename,
          local_version: file.version,
          latest_version: serverVersion,
          severity: driftSeverity(file.version, serverVersion),
          // A latest outside the manifest's caret pin signals a breaking change ahead.
          within_pin: file.pin ? satisfiesCaret(serverVersion, file.pin) : true,
        });
      }
    }
    const localNames = new Set(local.map((f) => f.filename));
    const missing_locally = latest
      .filter((s) => !localNames.has(s.filename))
      .map((s) => ({ filename: s.filename, latest_version: s.current_version }));

    return {
      project_type: pt.name,
      up_to_date,
      outdated,
      missing_locally,
      not_on_server,
      drift: outdated.length > 0 || missing_locally.length > 0,
    };
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
