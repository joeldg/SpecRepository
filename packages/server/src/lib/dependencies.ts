import type { Spec } from "@specregistry/shared";
import type { Db } from "../db.js";

export interface SpecDependencyEdge {
  from_spec_id: string;
  from_filename: string;
  to_spec_id: string | null;
  to_filename: string;
  relation: "references" | "depends_on" | "supersedes" | "overrides";
}

function relationFor(text: string): SpecDependencyEdge["relation"] {
  if (/\bsupersedes?\b/i.test(text)) return "supersedes";
  if (/\bdepends on\b/i.test(text)) return "depends_on";
  return "references";
}

export function dependencyMap(db: Db, projectTypeId?: string, projectId?: string) {
  const params: unknown[] = [];
  let filter = "";
  if (projectId) {
    filter = "WHERE s.project_id = ? OR (s.project_id IS NULL AND (s.project_type_id = (SELECT project_type_id FROM repo_consumers WHERE id = ?) OR pt.scope = 'global'))";
    params.push(projectId, projectId);
  } else if (projectTypeId) {
    filter = "WHERE s.project_id IS NULL AND (s.project_type_id = ? OR pt.scope = 'global')";
    params.push(projectTypeId);
  }
  const specs = db
    .prepare(
      `SELECT s.*, pt.name AS project_type_name, pt.scope AS project_type_scope, rc.repo AS project_name
       FROM specs s
       JOIN project_types pt ON pt.id = s.project_type_id
       LEFT JOIN repo_consumers rc ON rc.id = s.project_id
       ${filter}
       ORDER BY pt.scope = 'global' DESC, pt.name, s.filename`
    )
    .all(...params) as Array<Spec & { project_type_name: string; project_type_scope: string; project_name: string | null }>;
  const byFilename = new Map(specs.map((spec) => [spec.filename.toLowerCase(), spec]));
  const edges: SpecDependencyEdge[] = [];

  for (const spec of specs) {
    const seen = new Set<string>();
    for (const match of spec.content.matchAll(/\b(?:depends on|references?|see|supersedes?)\s+`?([A-Z0-9_.-]+\.md)`?/gi)) {
      const toFilename = match[1];
      const key = `${spec.id}:${toFilename.toLowerCase()}:${relationFor(match[0])}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from_spec_id: spec.id,
        from_filename: spec.filename,
        to_spec_id: byFilename.get(toFilename.toLowerCase())?.id ?? null,
        to_filename: toFilename,
        relation: relationFor(match[0]),
      });
    }
  }

  for (const spec of specs.filter((item) => item.project_id)) {
    const overridden = specs.find(
      (candidate) =>
        candidate.id !== spec.id &&
        candidate.project_id === null &&
        candidate.filename.toLowerCase() === spec.filename.toLowerCase()
    );
    if (!overridden) continue;
    edges.push({
      from_spec_id: spec.id,
      from_filename: spec.filename,
      to_spec_id: overridden.id,
      to_filename: overridden.filename,
      relation: "overrides",
    });
  }

  return {
    specs: specs.map(({ content: _content, ...spec }) => spec),
    edges,
    unresolved: edges.filter((edge) => !edge.to_spec_id && edge.relation !== "overrides"),
  };
}
