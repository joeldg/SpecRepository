import type { Db } from "../db.js";

export interface SpecTemplateRow {
  id: string;
  filename: string;
  required_sections: string;
  content_template: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface LintReport {
  template_id: string;
  missing_sections: string[];
  ok: boolean;
}

export function findTemplate(db: Db, filename: string): SpecTemplateRow | undefined {
  return db
    .prepare("SELECT * FROM spec_templates WHERE filename = ? COLLATE NOCASE")
    .get(filename) as SpecTemplateRow | undefined;
}

/**
 * Conformance check: every required section heading must appear in the document.
 * Matching is case-insensitive against heading text (any level).
 */
export function lintContent(db: Db, filename: string, content: string): LintReport | null {
  const template = findTemplate(db, filename);
  if (!template) return null;
  const required: string[] = JSON.parse(template.required_sections);
  if (required.length === 0) return { template_id: template.id, missing_sections: [], ok: true };

  const headings = new Set<string>();
  let inFence = false;
  for (const line of content.split("\n")) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) headings.add(match[1].toLowerCase());
  }

  const missing = required.filter((section) => !headings.has(section.toLowerCase()));
  return { template_id: template.id, missing_sections: missing, ok: missing.length === 0 };
}
