import type { FastifyInstance } from "fastify";
import type { StubPrompt, StubPromptResponse } from "@specregistry/shared";
import { requireProjectType, requireString } from "../helpers.js";

export async function stubPromptRoutes(app: FastifyInstance): Promise<void> {
  // Tailored LLM prompts for generating missing spec files from an existing codebase.
  app.post("/cli/stub-prompts", async (req): Promise<StubPromptResponse> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectTypeName = requireString(body, "project_type");
    const detectedLanguages = Array.isArray(body.detected_languages)
      ? (body.detected_languages as string[]).filter((l) => typeof l === "string")
      : [];
    const pt = requireProjectType(app.db, projectTypeName);

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
