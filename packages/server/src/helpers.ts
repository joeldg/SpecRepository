import type { ProjectType, Spec } from "@specregistry/shared";
import type { Db } from "./db.js";

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
  }
}

/** Look up a project type by id or (case-insensitive) name. */
export function findProjectType(db: Db, idOrName: string): ProjectType | undefined {
  return db
    .prepare("SELECT * FROM project_types WHERE id = ? OR name = ? COLLATE NOCASE")
    .get(idOrName, idOrName) as ProjectType | undefined;
}

export function requireProjectType(db: Db, idOrName: string): ProjectType {
  const pt = findProjectType(db, idOrName);
  if (!pt) throw new HttpError(404, `Unknown project type: ${idOrName}`);
  return pt;
}

export interface ProjectConsumer {
  id: string;
  repo: string;
  branch: string | null;
  commit_sha: string | null;
  project_type_id: string;
  specs_path: string;
  manifest_path: string;
  source: string;
  first_seen_at: string;
  last_seen_at: string;
}

export function findProjectConsumer(db: Db, idOrRepo: string, projectTypeId?: string): ProjectConsumer | undefined {
  if (projectTypeId) {
    return db
      .prepare("SELECT * FROM repo_consumers WHERE (id = ? OR repo = ?) AND project_type_id = ?")
      .get(idOrRepo, idOrRepo, projectTypeId) as ProjectConsumer | undefined;
  }
  return db
    .prepare("SELECT * FROM repo_consumers WHERE id = ? OR repo = ? ORDER BY last_seen_at DESC LIMIT 1")
    .get(idOrRepo, idOrRepo) as ProjectConsumer | undefined;
}

export function requireProjectConsumer(db: Db, idOrRepo: string, projectTypeId?: string): ProjectConsumer {
  const project = findProjectConsumer(db, idOrRepo, projectTypeId);
  if (!project) throw new HttpError(404, `Unknown project: ${idOrRepo}`);
  return project;
}

export function requireSpec(db: Db, id: string): Spec {
  const spec = db.prepare("SELECT * FROM specs WHERE id = ? AND deleted_at IS NULL").get(id) as Spec | undefined;
  if (!spec) throw new HttpError(404, `Unknown spec: ${id}`);
  return spec;
}

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `Missing or empty required field: ${field}`);
  }
  return value;
}

export function requireOneOf<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[]
): T {
  const value = requireString(body, field);
  if (!allowed.includes(value as T)) {
    throw new HttpError(400, `Field ${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}
