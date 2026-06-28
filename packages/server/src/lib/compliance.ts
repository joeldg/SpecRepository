import type { ProjectType } from "@specregistry/shared";
import type { Db } from "../db.js";
import { now, uuid } from "../db.js";

export interface CompliancePolicy {
  min_coverage: number; // 0..1
  max_drift: number; // 0..1
  required_mapped_kinds: string[];
}

export const DEFAULT_COMPLIANCE_POLICY: CompliancePolicy = {
  min_coverage: 0.8,
  max_drift: 0.2,
  required_mapped_kinds: ["route", "schema"],
};

interface PolicyRow {
  min_coverage: number;
  max_drift: number;
  required_mapped_kinds: string;
}

/** Per-project-type policy if set, else the global default row, else built-in defaults. */
export function getCompliancePolicy(db: Db, projectTypeId: string | null): CompliancePolicy {
  const row = (projectTypeId
    ? db.prepare("SELECT * FROM compliance_policies WHERE project_type_id = ?").get(projectTypeId)
    : undefined) as PolicyRow | undefined;
  const fallback = db.prepare("SELECT * FROM compliance_policies WHERE project_type_id IS NULL").get() as
    | PolicyRow
    | undefined;
  const picked = row ?? fallback;
  if (!picked) return DEFAULT_COMPLIANCE_POLICY;
  let kinds = DEFAULT_COMPLIANCE_POLICY.required_mapped_kinds;
  try {
    const parsed = JSON.parse(picked.required_mapped_kinds);
    if (Array.isArray(parsed)) kinds = parsed.filter((k) => typeof k === "string");
  } catch {
    // keep default
  }
  return { min_coverage: picked.min_coverage, max_drift: picked.max_drift, required_mapped_kinds: kinds };
}

export interface TraceSignals {
  coverage_ratio: number;
  drift_score: number;
  drift_severity: string;
  unlinked_by_kind: Record<string, number>;
  source: "inline" | "stored" | "none";
  generated_at?: string;
}

function signalsFromTrace(trace: Record<string, unknown> | undefined, source: "inline" | "stored"): TraceSignals | null {
  if (!trace) return null;
  const coverage = (trace.coverage ?? {}) as Record<string, unknown>;
  const drift = (trace.drift ?? {}) as Record<string, unknown>;
  const unlinkedByKind = (coverage.unlinked_by_kind ?? {}) as Record<string, number>;
  return {
    coverage_ratio: Number(coverage.coverage_ratio ?? 0),
    drift_score: Number(drift.score ?? 0),
    drift_severity: String(drift.severity ?? "none"),
    unlinked_by_kind: unlinkedByKind,
    source,
    generated_at: typeof trace.generated_at === "string" ? trace.generated_at : undefined,
  };
}

/** Latest uploaded code-trace report for a repo consumer, parsed from raw_json. */
function storedSignals(db: Db, consumerId: string): TraceSignals | null {
  const row = db
    .prepare("SELECT raw_json, generated_at FROM code_trace_reports WHERE consumer_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(consumerId) as { raw_json: string; generated_at: string } | undefined;
  if (!row) return null;
  try {
    return signalsFromTrace(JSON.parse(row.raw_json), "stored");
  } catch {
    return null;
  }
}

export interface ComplianceGap {
  check: "trace" | "coverage" | "drift" | "mapping";
  detail: string;
  recommended_action: string;
}

export interface ComplianceVerdict {
  compliant: boolean;
  objective_score: number;
  self_assessed_score: number | null;
  over_claimed: boolean;
  coverage_ratio: number | null;
  drift_score: number | null;
  policy: CompliancePolicy;
  outstanding: ComplianceGap[];
  recommended_actions: string[];
  directive: string;
  iteration: number;
}

export interface EvaluateInput {
  pt: ProjectType;
  consumerId?: string;
  repo?: string;
  trace?: Record<string, unknown>;
  selfAssessedScore?: number | null;
}

/**
 * The objective + self-score compliance gate. Computes a verdict from measured
 * coverage/drift/unmapped signals against the project type's policy, records an
 * attestation, and returns a directive that loops the agent until it actually passes.
 */
export function evaluateCompliance(db: Db, input: EvaluateInput): ComplianceVerdict {
  const policy = getCompliancePolicy(db, input.pt.id);
  const signals =
    signalsFromTrace(input.trace, "inline") ??
    (input.consumerId ? storedSignals(db, input.consumerId) : null) ?? {
      coverage_ratio: 0,
      drift_score: 1,
      drift_severity: "unknown",
      unlinked_by_kind: {},
      source: "none" as const,
    };

  const outstanding: ComplianceGap[] = [];
  if (signals.source === "none") {
    outstanding.push({
      check: "trace",
      detail: "No code-trace data available for this repo.",
      recommended_action: "Run `specreg code-map --report` (or `specreg comply`) to generate and upload traceability data.",
    });
  } else {
    if (signals.coverage_ratio < policy.min_coverage) {
      outstanding.push({
        check: "coverage",
        detail: `Traceability coverage ${(signals.coverage_ratio * 100).toFixed(0)}% is below the required ${(policy.min_coverage * 100).toFixed(0)}%.`,
        recommended_action: "Add inline `// @spec[FILE#section]` annotations to governed code entities, then regenerate the code map.",
      });
    }
    if (signals.drift_score > policy.max_drift) {
      outstanding.push({
        check: "drift",
        detail: `Drift score ${(signals.drift_score * 100).toFixed(0)}% exceeds the allowed ${(policy.max_drift * 100).toFixed(0)}%.`,
        recommended_action: "Link unmapped entities to the specs that govern them (annotations or spec updates), then regenerate.",
      });
    }
    for (const kind of policy.required_mapped_kinds) {
      const unmapped = Number(signals.unlinked_by_kind[kind] ?? 0);
      if (unmapped > 0) {
        outstanding.push({
          check: "mapping",
          detail: `${unmapped} ${kind} entit${unmapped === 1 ? "y is" : "ies are"} not mapped to any spec.`,
          recommended_action: `Map every ${kind} to a governing spec section, or report a spec gap if none exists.`,
        });
      }
    }
  }

  const compliant = outstanding.length === 0;
  // Objective score blends coverage and (1 - drift); 0 when no trace exists.
  const objective_score =
    signals.source === "none"
      ? 0
      : Math.max(0, Math.min(100, Math.round((signals.coverage_ratio * 0.6 + (1 - signals.drift_score) * 0.4) * 100)));
  const selfScore = typeof input.selfAssessedScore === "number" ? input.selfAssessedScore : null;
  const over_claimed = selfScore !== null && !compliant && selfScore > objective_score + 10;

  const recommended_actions = outstanding.map((g) => g.recommended_action);
  if (!compliant) recommended_actions.push("Re-run the compliance check after remediation; do not report the task complete until it passes.");

  let directive: string;
  if (compliant) {
    directive = "COMPLIANT — objective thresholds satisfied. You may report this task complete.";
  } else if (over_claimed) {
    directive = `NOT COMPLIANT — you self-assessed ${selfScore} but measured compliance is ${objective_score}. Continue remediation and re-run the compliance check; do not report the task complete.`;
  } else {
    directive = "NOT COMPLIANT — continue remediation and re-run the compliance check. Do not report the task complete.";
  }

  const priorCount = input.repo
    ? (db.prepare("SELECT COUNT(*) AS n FROM compliance_attestations WHERE repo = ?").get(input.repo) as { n: number }).n
    : 0;
  const iteration = priorCount + 1;

  db.prepare(
    `INSERT INTO compliance_attestations
       (id, project_type_id, consumer_id, repo, self_assessed_score, objective_score, compliant,
        coverage_ratio, drift_score, outstanding, iteration, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid(),
    input.pt.id,
    input.consumerId ?? null,
    input.repo ?? null,
    selfScore,
    objective_score,
    compliant ? 1 : 0,
    signals.source === "none" ? null : signals.coverage_ratio,
    signals.source === "none" ? null : signals.drift_score,
    JSON.stringify(outstanding),
    iteration,
    now()
  );

  return {
    compliant,
    objective_score,
    self_assessed_score: selfScore,
    over_claimed,
    coverage_ratio: signals.source === "none" ? null : signals.coverage_ratio,
    drift_score: signals.source === "none" ? null : signals.drift_score,
    policy,
    outstanding,
    recommended_actions,
    directive,
    iteration,
  };
}
