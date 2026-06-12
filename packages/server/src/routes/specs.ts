import type { FastifyInstance } from "fastify";
import AdmZip from "adm-zip";
import { createTwoFilesPatch } from "diff";
import type { Spec, SpecVersion, VersionDelta } from "@specregistry/shared";
import { now, uuid } from "../db.js";
import {
  HttpError,
  findProjectType,
  requireOneOf,
  requireProjectType,
  requireSpec,
  requireString,
} from "../helpers.js";

const SUMMARY_SELECT = `
  SELECT s.id, s.project_type_id, s.filename, s.current_version, s.status,
         s.updated_by, s.created_at, s.updated_at,
         pt.name AS project_type_name, pt.scope AS project_type_scope,
         (SELECT COUNT(*) FROM agent_feedback f WHERE f.spec_id = s.id AND f.status = 'open') AS open_feedback_count,
         (SELECT COUNT(*) FROM change_requests cr WHERE cr.spec_id = s.id AND cr.status = 'pending') AS pending_review_count
  FROM specs s
  JOIN project_types pt ON pt.id = s.project_type_id
`;

export async function specRoutes(app: FastifyInstance): Promise<void> {
  // List all global and project-type specs (summaries, no markdown body).
  app.get("/specs", async (req) => {
    const { project_type_id } = req.query as { project_type_id?: string };
    if (project_type_id) {
      return app.db
        .prepare(`${SUMMARY_SELECT} WHERE s.project_type_id = ? ORDER BY s.filename`)
        .all(project_type_id);
    }
    return app.db
      .prepare(`${SUMMARY_SELECT} ORDER BY pt.scope = 'global' DESC, pt.name, s.filename`)
      .all();
  });

  // Zipped folder of the latest published specs for a project type (+ all global specs).
  app.get("/specs/:key/download", async (req, reply) => {
    const { key } = req.params as { key: string };
    const pt = requireProjectType(app.db, key);
    const specs = app.db
      .prepare(
        `SELECT s.* FROM specs s
         JOIN project_types pt ON pt.id = s.project_type_id
         WHERE s.status = 'published' AND (pt.id = ? OR pt.scope = 'global')
         ORDER BY pt.scope = 'global' DESC, s.filename`
      )
      .all(pt.id) as Spec[];
    if (specs.length === 0) throw new HttpError(404, `No published specs for: ${pt.name}`);

    const zip = new AdmZip();
    // Project-type specs are added last so they win over a same-named global spec.
    for (const spec of specs) {
      zip.addFile(spec.filename, Buffer.from(spec.content, "utf8"));
    }
    const manifest = specs.map((s) => ({
      filename: s.filename,
      version: s.current_version,
      project_type: s.project_type_id === pt.id ? pt.name : "Global",
    }));
    zip.addFile(
      ".specregistry.json",
      Buffer.from(JSON.stringify({ project_type: pt.name, fetched_at: now(), specs: manifest }, null, 2))
    );

    reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${pt.name.replace(/[^\w.-]+/g, "_")}-specs.zip"`);
    return zip.toBuffer();
  });

  // Full spec detail with version history, change requests, and feedback.
  app.get("/specs/:key", async (req) => {
    const { key } = req.params as { key: string };
    const spec = requireSpec(app.db, key);
    const versions = app.db
      .prepare("SELECT * FROM spec_versions WHERE spec_id = ? ORDER BY published_at DESC")
      .all(spec.id) as SpecVersion[];
    const change_requests = app.db
      .prepare("SELECT * FROM change_requests WHERE spec_id = ? ORDER BY created_at DESC")
      .all(spec.id);
    const feedback = app.db
      .prepare("SELECT * FROM agent_feedback WHERE spec_id = ? ORDER BY created_at DESC")
      .all(spec.id);
    return { ...spec, versions, change_requests, feedback };
  });

  // Create a new draft spec (0.1.0). Publishing records the first immutable version.
  app.post("/specs", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectTypeId = requireString(body, "project_type_id");
    const filename = requireString(body, "filename");
    const updatedBy = requireString(body, "updated_by");
    const content = typeof body.content === "string" ? body.content : "";
    const pt = findProjectType(app.db, projectTypeId);
    if (!pt) throw new HttpError(404, `Unknown project type: ${projectTypeId}`);
    const duplicate = app.db
      .prepare("SELECT id FROM specs WHERE project_type_id = ? AND filename = ?")
      .get(pt.id, filename);
    if (duplicate) throw new HttpError(409, `Spec ${filename} already exists for ${pt.name}`);

    const id = uuid();
    const ts = now();
    app.db
      .prepare(
        `INSERT INTO specs (id, project_type_id, filename, current_version, status, content, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, '0.1.0', 'draft', ?, ?, ?, ?)`
      )
      .run(id, pt.id, filename, content, updatedBy, ts, ts);
    reply.code(201);
    return requireSpec(app.db, id);
  });

  // Direct edits are only allowed while a spec is still a draft.
  app.put("/specs/:key", async (req) => {
    const { key } = req.params as { key: string };
    const spec = requireSpec(app.db, key);
    if (spec.status !== "draft") {
      throw new HttpError(409, "Published specs change via the review workflow (POST /specs/review)");
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const content = requireString(body, "content");
    const updatedBy = requireString(body, "updated_by");
    app.db
      .prepare("UPDATE specs SET content = ?, updated_by = ?, updated_at = ? WHERE id = ?")
      .run(content, updatedBy, now(), spec.id);
    return requireSpec(app.db, spec.id);
  });

  // Publish a draft: becomes 1.0.0 and gains an immutable version record.
  app.post("/specs/:key/publish", async (req) => {
    const { key } = req.params as { key: string };
    const spec = requireSpec(app.db, key);
    if (spec.status !== "draft") throw new HttpError(409, `Spec is not a draft (status: ${spec.status})`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const publishedBy = requireString(body, "published_by");
    const ts = now();
    const version = "1.0.0";
    const publish = app.db.transaction(() => {
      app.db
        .prepare("UPDATE specs SET status = 'published', current_version = ?, updated_by = ?, updated_at = ? WHERE id = ?")
        .run(version, publishedBy, ts, spec.id);
      app.db
        .prepare(
          `INSERT INTO spec_versions (id, spec_id, version, content, published_by, published_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(uuid(), spec.id, version, spec.content, publishedBy, ts);
    });
    publish();
    return requireSpec(app.db, spec.id);
  });

  // Submit a markdown change request; the spec enters pending_review.
  app.post("/specs/review", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const specId = requireString(body, "spec_id");
    const proposedContent = requireString(body, "proposed_content");
    const proposedBy = requireString(body, "proposed_by");
    const versionDelta = requireOneOf(body, "version_delta", ["major", "minor", "patch"] as const satisfies readonly VersionDelta[]);
    const spec = requireSpec(app.db, specId);
    if (spec.status === "draft") {
      throw new HttpError(409, "Draft specs are edited directly (PUT /specs/:id), not reviewed");
    }
    if (proposedContent === spec.content) {
      throw new HttpError(400, "Proposed content is identical to the current published content");
    }

    const diff = createTwoFilesPatch(
      `${spec.filename}@${spec.current_version}`,
      `${spec.filename}@proposed`,
      spec.content,
      proposedContent
    );
    const id = uuid();
    const ts = now();
    const submit = app.db.transaction(() => {
      app.db
        .prepare(
          `INSERT INTO change_requests (id, spec_id, proposed_by, version_delta, diff, proposed_content, summary, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        )
        .run(id, spec.id, proposedBy, versionDelta, diff, proposedContent, (body.summary as string) ?? null, ts);
      app.db.prepare("UPDATE specs SET status = 'pending_review', updated_at = ? WHERE id = ?").run(ts, spec.id);
    });
    submit();
    reply.code(201);
    return app.db.prepare("SELECT * FROM change_requests WHERE id = ?").get(id);
  });
}
