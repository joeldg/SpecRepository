import type { Spec } from "@specregistry/shared";
import type { Db } from "../db.js";
import { sectionAnchor, splitSections } from "./sections.js";

export interface SearchResult {
  spec_id: string;
  filename: string;
  project_type_id: string;
  project_id: string | null;
  project_type_name: string;
  project_name: string | null;
  effective_scope: "global" | "project_type" | "project";
  current_version: string;
  section: string;
  section_anchor: string;
  permalink: string;
  excerpt: string;
}

export function reindexSpec(db: Db, spec: Pick<Spec, "id" | "content">): void {
  db.prepare("DELETE FROM spec_chunks WHERE spec_id = ?").run(spec.id);
  const insert = db.prepare("INSERT INTO spec_chunks (spec_id, section, content) VALUES (?, ?, ?)");
  for (const chunk of splitSections(spec.content)) {
    insert.run(spec.id, chunk.section, chunk.text);
  }
}

/** Rebuild the whole index from published specs (startup / after seed). */
export function reindexAll(db: Db): void {
  db.prepare("DELETE FROM spec_chunks").run();
  const specs = db.prepare("SELECT id, content FROM specs WHERE status != 'draft'").all() as Array<
    Pick<Spec, "id" | "content">
  >;
  for (const spec of specs) reindexSpec(db, spec);
}

/** Quote each term so user input can't break FTS5 query syntax. Terms are ANDed. */
function toFtsQuery(query: string): string {
  return query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(" ");
}

export function searchSpecs(db: Db, query: string, projectTypeId?: string, limit = 20, projectId?: string): SearchResult[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  let filter = "";
  const params: unknown[] = [fts];
  if (projectTypeId && projectId) {
    filter = "AND (s.project_id = ? OR (s.project_id IS NULL AND (pt.id = ? OR pt.scope = 'global')))";
    params.push(projectId, projectTypeId);
  } else if (projectTypeId) {
    filter = "AND s.project_id IS NULL AND (pt.id = ? OR pt.scope = 'global')";
    params.push(projectTypeId);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT c.spec_id, s.filename, s.project_type_id, s.project_id,
              pt.name AS project_type_name, rc.repo AS project_name,
              CASE
                WHEN s.project_id IS NOT NULL THEN 'project'
                WHEN pt.scope = 'global' THEN 'global'
                ELSE 'project_type'
              END AS effective_scope,
              s.current_version, c.section,
              snippet(spec_chunks, 2, '[', ']', '…', 32) AS excerpt
       FROM spec_chunks c
       JOIN specs s ON s.id = c.spec_id
       JOIN project_types pt ON pt.id = s.project_type_id
       LEFT JOIN repo_consumers rc ON rc.id = s.project_id
       WHERE spec_chunks MATCH ? ${filter}
       ORDER BY rank
       LIMIT ?`
    )
    .all(...params) as Array<Omit<SearchResult, "section_anchor" | "permalink">>;
  return rows.map((row) => {
    const anchor = sectionAnchor(row.section);
    return { ...row, section_anchor: anchor, permalink: `/api/v1/specs/${row.spec_id}#${anchor}` };
  });
}
