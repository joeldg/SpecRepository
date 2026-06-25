import type { Spec } from "@specregistry/shared";
import type { Db } from "../db.js";
import { sectionAnchor, splitSections } from "./sections.js";

export interface ContradictionFinding {
  severity: "medium" | "high";
  proposed_section: string;
  proposed_anchor: string;
  proposed_statement: string;
  conflicting_spec_id: string;
  conflicting_filename: string;
  conflicting_project_type_name: string;
  conflicting_section: string;
  conflicting_anchor: string;
  conflicting_statement: string;
  reason: string;
}

export interface ContradictionReport {
  ok: boolean;
  finding_count: number;
  findings: ContradictionFinding[];
}

interface Norm {
  section: string;
  anchor: string;
  statement: string;
  key: string;
  polarity: "allow" | "deny" | "require";
}

const NEGATIVE = /\b(must not|shall not|should not|may not|cannot|can't|prohibited|forbidden|disallowed|not allowed)\b/i;
const POSITIVE = /\b(must|shall|required|requires|should|allowed|permitted|may)\b/i;

function normalizeStatement(statement: string): string {
  return statement
    .toLowerCase()
    .replace(/`[^`]+`/g, " ")
    .replace(/\b(must not|shall not|should not|may not|cannot|can't|must|shall|required|requires|should|allowed|permitted|may|prohibited|forbidden|disallowed|not allowed)\b/g, " ")
    .replace(/\b(the|a|an|all|any|each|every|be|is|are|to|for|with|by|of|and|or|in|on|at|as)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 12)
    .join(" ");
}

function polarity(statement: string): Norm["polarity"] | null {
  if (NEGATIVE.test(statement)) return "deny";
  if (/\b(allowed|permitted|may)\b/i.test(statement)) return "allow";
  if (POSITIVE.test(statement)) return "require";
  return null;
}

function normativeStatements(content: string): Norm[] {
  const norms: Norm[] = [];
  for (const section of splitSections(content)) {
    const sentences = section.text
      .replace(/\n+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    for (const statement of sentences) {
      const p = polarity(statement);
      if (!p) continue;
      const key = normalizeStatement(statement);
      if (key.length < 8) continue;
      norms.push({ section: section.section, anchor: section.anchor, statement, key, polarity: p });
    }
  }
  return norms;
}

function conflicts(a: Norm, b: Norm): boolean {
  if (a.key !== b.key) return false;
  return (
    (a.polarity === "deny" && (b.polarity === "allow" || b.polarity === "require")) ||
    (b.polarity === "deny" && (a.polarity === "allow" || a.polarity === "require"))
  );
}

export function analyzeContradictions(db: Db, spec: Spec, proposedContent: string): ContradictionReport {
  const proposed = normativeStatements(proposedContent);
  const existing = db
    .prepare(
      `SELECT s.id, s.filename, s.content, pt.name AS project_type_name
       FROM specs s JOIN project_types pt ON pt.id = s.project_type_id
       WHERE s.id != ?
         AND s.status IN ('published', 'pending_review')
         AND s.deleted_at IS NULL
         AND (s.project_type_id = ? OR pt.scope = 'global')`
    )
    .all(spec.id, spec.project_type_id) as Array<{
    id: string;
    filename: string;
    content: string;
    project_type_name: string;
  }>;

  const findings: ContradictionFinding[] = [];
  for (const other of existing) {
    const norms = normativeStatements(other.content);
    for (const next of proposed) {
      for (const prior of norms) {
        if (!conflicts(next, prior)) continue;
        findings.push({
          severity: next.polarity === "deny" || prior.polarity === "deny" ? "high" : "medium",
          proposed_section: next.section,
          proposed_anchor: next.anchor,
          proposed_statement: next.statement,
          conflicting_spec_id: other.id,
          conflicting_filename: other.filename,
          conflicting_project_type_name: other.project_type_name,
          conflicting_section: prior.section,
          conflicting_anchor: sectionAnchor(prior.section),
          conflicting_statement: prior.statement,
          reason: "A proposed normative statement appears to reverse existing governed guidance.",
        });
      }
    }
  }

  return { ok: findings.length === 0, finding_count: findings.length, findings: findings.slice(0, 20) };
}
