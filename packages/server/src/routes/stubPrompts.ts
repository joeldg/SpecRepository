import type { FastifyInstance } from "fastify";
import type { Spec, StubPrompt, StubPromptResponse, SyncCheckResponse } from "@specregistry/shared";
import { requireProjectType, requireString } from "../helpers.js";
import { recordUsage } from "../lib/events.js";

export async function stubPromptRoutes(app: FastifyInstance): Promise<void> {
  // Drift detection for `specreg sync` / `specreg check --ci`.
  app.post("/cli/sync-check", async (req): Promise<SyncCheckResponse> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pt = requireProjectType(app.db, requireString(body, "project_type"));
    const local = Array.isArray(body.specs)
      ? (body.specs as Array<{ filename: string; version: string }>).filter(
          (s) => typeof s?.filename === "string" && typeof s?.version === "string"
        )
      : [];
    recordUsage(app.db, "sync_check", pt.id);

    const latest = app.db
      .prepare(
        `SELECT s.filename, s.current_version FROM specs s
         JOIN project_types pt ON pt.id = s.project_type_id
         WHERE s.status = 'published' AND (pt.id = ? OR pt.scope = 'global')`
      )
      .all(pt.id) as Array<Pick<Spec, "filename" | "current_version">>;
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
        outdated.push({ filename: file.filename, local_version: file.version, latest_version: serverVersion });
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
