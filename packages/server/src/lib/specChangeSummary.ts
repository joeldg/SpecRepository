import type { Spec, VersionDelta } from "@specregistry/shared";
import type { Db } from "../db.js";
import { reviewImpact } from "./reviewImpact.js";

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function sectionsFromReport(report: unknown, key: "added_sections" | "removed_sections"): string[] {
  if (!report || typeof report !== "object") return [];
  const value = (report as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function riskFactors(report: unknown): string[] {
  if (!report || typeof report !== "object") return [];
  const value = (report as Record<string, unknown>).factors;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export interface SpecChangeEvidence {
  compatibility?: string | null;
  lint?: string | null;
  contradictions?: string | null;
  risk?: string | null;
}

export function migrationChecklist(db: Db, spec: Spec, delta: VersionDelta, evidence: SpecChangeEvidence = {}) {
  const impact = reviewImpact(db, spec, delta);
  const compatibility = parseJson(evidence.compatibility);
  const risk = parseJson(evidence.risk);
  const added = sectionsFromReport(compatibility, "added_sections");
  const removed = sectionsFromReport(compatibility, "removed_sections");
  const factors = riskFactors(risk);
  const items = [
    `Run \`specreg sync\` and commit the updated \`${spec.filename}\` plus \`specs/.specregistry.json\`.`,
    `Run \`specreg check\` in CI after syncing to confirm the project is on the approved version.`,
    `Review implementation code, tests, and docs against \`${spec.filename}\` v${spec.current_version}.`,
  ];
  if (removed.length > 0) {
    items.push(`Audit removed or renamed sections: ${removed.join(", ")}.`);
  }
  if (added.length > 0) {
    items.push(`Add or update implementation coverage for new sections: ${added.join(", ")}.`);
  }
  if (impact.dependent_specs.length > 0) {
    items.push(`Review dependent specs for consistency: ${impact.dependent_specs.map((dep) => dep.filename).join(", ")}.`);
  }
  if (impact.feedback.open > 0) {
    items.push(`Triage ${impact.feedback.open} open feedback item(s) tied to this spec before treating migration as complete.`);
  }
  if (factors.length > 0) {
    items.push(`Pay special attention to risk factors: ${factors.join("; ")}.`);
  }
  if (delta === "major") {
    items.push("Treat this as a breaking governance change: update release notes and verify downstream owners explicitly acknowledged it.");
  }
  return {
    spec_id: spec.id,
    filename: spec.filename,
    version_delta: delta,
    impact_level: impact.level,
    affected_projects: impact.manifest_consumers.length,
    affected_subscriptions: impact.repo_subscriptions.length,
    dependent_specs: impact.dependent_specs,
    items,
  };
}

export function specChangeSummaryMarkdown(
  db: Db,
  spec: Spec,
  delta: VersionDelta,
  options: SpecChangeEvidence & {
    summary?: string | null;
    resulting_version?: string | null;
    file_path?: string;
  } = {}
): string {
  const impact = reviewImpact(db, spec, delta);
  const checklist = migrationChecklist(db, spec, delta, options);
  const compatibility = parseJson(options.compatibility);
  const added = sectionsFromReport(compatibility, "added_sections");
  const removed = sectionsFromReport(compatibility, "removed_sections");
  const version = options.resulting_version ?? spec.current_version;
  const filePath = options.file_path ?? spec.filename;

  const lines = [
    "Approved specification update distributed by SpecRegistry.",
    "",
    `- **File:** \`${filePath}\``,
    `- **Version:** ${version}`,
    `- **Delta:** ${delta}`,
    `- **Impact:** ${impact.level} (${impact.score}/100)`,
    `- **Affected reported projects:** ${impact.manifest_consumers.length}`,
    `- **Subscribed repos:** ${impact.repo_subscriptions.length}`,
  ];
  if (options.summary) lines.push(`- **Review summary:** ${options.summary}`);
  if (added.length > 0) lines.push(`- **Added sections:** ${added.join(", ")}`);
  if (removed.length > 0) lines.push(`- **Removed sections:** ${removed.join(", ")}`);
  lines.push("", "## Migration checklist");
  for (const item of checklist.items) lines.push(`- [ ] ${item}`);
  if (impact.dependent_specs.length > 0) {
    lines.push("", "## Dependent specs");
    for (const dep of impact.dependent_specs) lines.push(`- \`${dep.filename}\` (${dep.relation.replace("_", " ")})`);
  }
  lines.push("", "## Changelog", `- ${spec.filename} updated to ${version} through SpecRegistry governance.`);
  return lines.join("\n");
}
