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
  missing_examples: boolean;
  missing_non_goals: boolean;
  missing_operational_sections: string[];
  ambiguity_terms: Array<{ term: string; line: number; text: string }>;
  warnings: string[];
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
  const required: string[] = template ? JSON.parse(template.required_sections) : [];

  const headings = new Set<string>();
  let inFence = false;
  const lines = content.split("\n");
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) headings.add(match[1].toLowerCase());
  }

  const missing = required.filter((section) => !headings.has(section.toLowerCase()));
  const normalizedHeadings = [...headings].map((heading) => heading.replace(/[^a-z0-9]+/g, " ").trim());
  const hasHeading = (aliases: string[]) => normalizedHeadings.some((heading) => aliases.includes(heading));
  const missingExamples = !hasHeading(["examples", "example"]) && !/```[\s\S]+```/.test(content);
  const missingNonGoals = !hasHeading(["non goals", "non goal", "out of scope"]);
  const operationalSections = [
    { name: "observability", aliases: ["observability", "monitoring", "metrics"] },
    { name: "failure modes", aliases: ["failure modes", "error handling", "rollback"] },
  ];
  const missingOperational = operationalSections
    .filter((section) => !hasHeading(section.aliases))
    .map((section) => section.name);
  const ambiguityPattern = /\b(tbd|todo|maybe|probably|usually|generally|as needed|where possible|etc\.?|and so on)\b/i;
  const ambiguityTerms = lines
    .map((line, index) => {
      const match = ambiguityPattern.exec(line);
      return match ? { term: match[1], line: index + 1, text: line.trim() } : null;
    })
    .filter((item): item is { term: string; line: number; text: string } => Boolean(item));
  const warnings = [
    ...(missingExamples ? ["Document should include examples or a fenced example block."] : []),
    ...(missingNonGoals ? ["Document should state non-goals or out-of-scope behavior."] : []),
    ...missingOperational.map((section) => `Document should include an operational section for ${section}.`),
    ...ambiguityTerms.map((item) => `Ambiguous term "${item.term}" on line ${item.line}.`),
  ];
  const ok = missing.length === 0 && ambiguityTerms.length === 0;
  return {
    template_id: template?.id ?? "built-in-quality-rules",
    missing_sections: missing,
    missing_examples: missingExamples,
    missing_non_goals: missingNonGoals,
    missing_operational_sections: missingOperational,
    ambiguity_terms: ambiguityTerms,
    warnings,
    ok,
  };
}
