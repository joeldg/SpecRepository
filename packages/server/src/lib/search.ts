import type { Spec } from "@specregistry/shared";
import type { Db } from "../db.js";

export interface SearchResult {
  spec_id: string;
  filename: string;
  project_type_id: string;
  project_type_name: string;
  current_version: string;
  section: string;
  excerpt: string;
}

/** Split markdown into sections at h1–h3 boundaries for chunked indexing. */
function splitSections(content: string): Array<{ section: string; text: string }> {
  const chunks: Array<{ section: string; text: string }> = [];
  let current = { section: "(intro)", text: "" };
  let inFence = false;
  for (const line of content.split("\n")) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const match = !inFence && /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (current.text.trim()) chunks.push(current);
      current = { section: match[1], text: "" };
    } else {
      current.text += line + "\n";
    }
  }
  if (current.text.trim()) chunks.push(current);
  return chunks;
}

export function reindexSpec(db: Db, spec: Pick<Spec, "id" | "content">): void {
  db.prepare("DELETE FROM spec_chunks WHERE spec_id = ?").run(spec.id);
  const insert = db.prepare("INSERT INTO spec_chunks (spec_id, section, content) VALUES (?, ?, ?)");
  for (const chunk of splitSections(spec.content)) {
    insert.run(spec.id, chunk.section, chunk.text.trim());
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

export function searchSpecs(db: Db, query: string, projectTypeId?: string, limit = 20): SearchResult[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const filter = projectTypeId ? "AND (pt.id = ? OR pt.scope = 'global')" : "";
  const params: unknown[] = [fts];
  if (projectTypeId) params.push(projectTypeId);
  params.push(limit);
  return db
    .prepare(
      `SELECT c.spec_id, s.filename, s.project_type_id, pt.name AS project_type_name,
              s.current_version, c.section,
              snippet(spec_chunks, 2, '[', ']', '…', 32) AS excerpt
       FROM spec_chunks c
       JOIN specs s ON s.id = c.spec_id
       JOIN project_types pt ON pt.id = s.project_type_id
       WHERE spec_chunks MATCH ? ${filter}
       ORDER BY rank
       LIMIT ?`
    )
    .all(...params) as SearchResult[];
}
