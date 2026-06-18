import type { Spec } from "@specregistry/shared";
import type { Db } from "../db.js";
import { sectionAnchor, splitSections } from "./sections.js";
import { cosine, embedText, getEmbeddingConfig, reindexSemanticSpec } from "./embeddings.js";

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
  score?: number;
  match_type?: "fts" | "semantic" | "hybrid";
  explanation?: string;
}

export function reindexSpec(db: Db, spec: Pick<Spec, "id" | "content">): void {
  db.prepare("DELETE FROM spec_chunks WHERE spec_id = ?").run(spec.id);
  const insert = db.prepare("INSERT INTO spec_chunks (spec_id, section, content) VALUES (?, ?, ?)");
  for (const chunk of splitSections(spec.content)) {
    insert.run(spec.id, chunk.section, chunk.text);
  }
}

export async function reindexSpecSearch(db: Db, spec: Pick<Spec, "id" | "content">): Promise<void> {
  reindexSpec(db, spec);
  try {
    await reindexSemanticSpec(db, spec);
  } catch {
    // Publishing must not fail because an external embedding provider is unavailable.
    // Manual /embeddings/reindex still surfaces provider errors.
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
    return {
      ...row,
      section_anchor: anchor,
      permalink: `/api/v1/specs/${row.spec_id}#${anchor}`,
      match_type: "fts",
      explanation: "Matched exact indexed terms with FTS5.",
    };
  });
}

function scopedRows(db: Db, projectTypeId?: string, projectId?: string) {
  let filter = "";
  const params: unknown[] = [];
  if (projectTypeId && projectId) {
    filter = "WHERE s.project_id = ? OR (s.project_id IS NULL AND (pt.id = ? OR pt.scope = 'global'))";
    params.push(projectId, projectTypeId);
  } else if (projectTypeId) {
    filter = "WHERE s.project_id IS NULL AND (pt.id = ? OR pt.scope = 'global')";
    params.push(projectTypeId);
  }
  return db
    .prepare(
      `SELECT s.id AS spec_id, s.filename, s.project_type_id, s.project_id,
              pt.name AS project_type_name, rc.repo AS project_name,
              CASE
                WHEN s.project_id IS NOT NULL THEN 'project'
                WHEN pt.scope = 'global' THEN 'global'
                ELSE 'project_type'
              END AS effective_scope,
              s.current_version
       FROM specs s
       JOIN project_types pt ON pt.id = s.project_type_id
       LEFT JOIN repo_consumers rc ON rc.id = s.project_id
       ${filter}`
    )
    .all(...params) as Array<Omit<SearchResult, "section" | "section_anchor" | "permalink" | "excerpt">>;
}

export async function semanticSearchSpecs(db: Db, query: string, projectTypeId?: string, limit = 20, projectId?: string): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const config = getEmbeddingConfig(db);
  const queryVector = await embedText(db, query, config);
  const scoped = new Map(scopedRows(db, projectTypeId, projectId).map((row) => [row.spec_id, row]));
  const rows = db
    .prepare("SELECT * FROM spec_embeddings WHERE provider = ? AND model = ?")
    .all(config.provider, config.model) as Array<{
      spec_id: string;
      section: string;
      section_anchor: string;
      vector: string;
    }>;
  const scored = rows
    .filter((row) => scoped.has(row.spec_id))
    .map((row) => {
      const score = cosine(queryVector, JSON.parse(row.vector) as number[]);
      const spec = scoped.get(row.spec_id)!;
      return {
        ...spec,
        section: row.section,
        section_anchor: row.section_anchor,
        permalink: `/api/v1/specs/${row.spec_id}#${row.section_anchor}`,
        excerpt: `Semantic match in ${row.section}`,
        score,
        match_type: "semantic" as const,
        explanation: `Vector similarity via ${config.provider}/${config.model}.`,
      };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
  return scored;
}

export async function hybridSearchSpecs(db: Db, query: string, projectTypeId?: string, limit = 20, projectId?: string): Promise<SearchResult[]> {
  const fts = searchSpecs(db, query, projectTypeId, limit, projectId).map((row, index) => ({
    ...row,
    score: 1 - index / Math.max(limit, 1),
  }));
  const semantic = await semanticSearchSpecs(db, query, projectTypeId, limit, projectId);
  const merged = new Map<string, SearchResult>();
  for (const row of semantic) {
    merged.set(`${row.spec_id}:${row.section_anchor}`, { ...row, match_type: "semantic" });
  }
  for (const row of fts) {
    const key = `${row.spec_id}:${row.section_anchor}`;
    const existing = merged.get(key);
    if (existing) {
      merged.set(key, {
        ...existing,
        excerpt: row.excerpt,
        score: Math.max(existing.score ?? 0, 0) * 0.65 + (row.score ?? 0) * 0.35,
        match_type: "hybrid",
        explanation: "Matched both semantic similarity and exact indexed terms.",
      });
    } else {
      merged.set(key, {
        ...row,
        match_type: "hybrid",
        explanation: "Matched exact indexed terms; no stronger semantic match was found.",
      });
    }
  }
  return [...merged.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
}

export type SearchMode = "fts" | "semantic" | "hybrid";

export async function searchSpecsByMode(
  db: Db,
  query: string,
  mode: SearchMode,
  projectTypeId?: string,
  limit = 20,
  projectId?: string
): Promise<SearchResult[]> {
  if (mode === "semantic") return semanticSearchSpecs(db, query, projectTypeId, limit, projectId);
  if (mode === "hybrid") return hybridSearchSpecs(db, query, projectTypeId, limit, projectId);
  return searchSpecs(db, query, projectTypeId, limit, projectId);
}
