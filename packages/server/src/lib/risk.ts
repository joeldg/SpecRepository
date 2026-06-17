import type { VersionDelta } from "@specregistry/shared";
import type { ContradictionReport } from "./contradictions.js";
import type { LintReport } from "./lint.js";

export interface RiskReport {
  score: number;
  level: "low" | "medium" | "high" | "critical";
  factors: string[];
}

export function scoreRisk(input: {
  filename: string;
  proposedContent: string;
  versionDelta: VersionDelta;
  compatibility?: { agrees_with_requested?: boolean; removed_sections?: string[] } | null;
  lint?: LintReport | null;
  contradictions?: ContradictionReport | null;
}): RiskReport {
  let score = 0;
  const factors: string[] = [];
  const filename = input.filename.toLowerCase();
  const content = input.proposedContent.toLowerCase();
  const add = (points: number, factor: string) => {
    score += points;
    factors.push(factor);
  };

  if (input.versionDelta === "major") add(25, "major version change");
  if (input.compatibility && input.compatibility.agrees_with_requested === false) add(20, "requested version delta is smaller than compatibility analysis suggests");
  if ((input.compatibility?.removed_sections?.length ?? 0) > 0) add(15, "removes governed sections");
  if ((input.contradictions?.finding_count ?? 0) > 0) add(30, "possible cross-spec contradiction");
  if (input.lint && !input.lint.ok) add(15, "quality lint failed");
  if ((input.lint?.warnings.length ?? 0) >= 3) add(10, "multiple quality lint warnings");
  if (/(security|auth|token|secret|credential|pii|privacy|encryption|tls|permission|role)/.test(filename + " " + content)) {
    add(20, "security or privacy-sensitive guidance");
  }
  if (/(migration|database|schema|rollback|deploy|availability|sla|incident)/.test(filename + " " + content)) {
    add(10, "operationally sensitive guidance");
  }

  score = Math.min(100, score);
  const level = score >= 75 ? "critical" : score >= 50 ? "high" : score >= 25 ? "medium" : "low";
  return { score, level, factors };
}
