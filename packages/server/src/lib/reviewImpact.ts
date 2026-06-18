import type { Spec, VersionDelta } from "@specregistry/shared";
import type { Db } from "../db.js";
import { dependencyMap } from "./dependencies.js";

type ImpactLevel = "low" | "medium" | "high" | "critical";

function levelFrom(score: number): ImpactLevel {
  if (score >= 85) return "critical";
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}

function versionWeight(delta: VersionDelta): number {
  if (delta === "major") return 35;
  if (delta === "minor") return 15;
  return 5;
}

export function reviewImpact(db: Db, spec: Spec, versionDelta: VersionDelta) {
  const projectType = db.prepare("SELECT id, name, scope FROM project_types WHERE id = ?").get(spec.project_type_id) as
    | { id: string; name: string; scope: "global" | "project_type" }
    | undefined;
  const scope = spec.project_id ? "project" : projectType?.scope === "global" ? "global" : "project_type";
  const affectedProjectTypes =
    scope === "global"
      ? db.prepare("SELECT id, name, scope FROM project_types WHERE scope = 'project_type' ORDER BY name").all()
      : projectType
        ? [projectType]
        : [];
  const manifestConsumers =
    scope === "global"
      ? db.prepare("SELECT id, repo, branch, commit_sha, manifest_path, last_seen_at FROM repo_consumers ORDER BY repo").all()
      : scope === "project"
        ? db
            .prepare("SELECT id, repo, branch, commit_sha, manifest_path, last_seen_at FROM repo_consumers WHERE id = ? ORDER BY repo")
            .all(spec.project_id)
        : db
            .prepare("SELECT id, repo, branch, commit_sha, manifest_path, last_seen_at FROM repo_consumers WHERE project_type_id = ? ORDER BY repo")
            .all(spec.project_type_id);
  const subscriptions =
    scope === "global"
      ? db.prepare("SELECT repo, branch, base_path FROM repo_subscriptions ORDER BY repo").all()
      : db
          .prepare("SELECT repo, branch, base_path FROM repo_subscriptions WHERE project_type_id = ? ORDER BY repo")
          .all(spec.project_type_id);
  const map = dependencyMap(db, scope === "global" ? undefined : spec.project_type_id, scope === "project" ? spec.project_id ?? undefined : undefined);
  const dependentSpecs = map.edges
    .filter((edge) => edge.to_spec_id === spec.id)
    .map((edge) => ({
      spec_id: edge.from_spec_id,
      filename: edge.from_filename,
      relation: edge.relation,
    }));
  const feedback = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open
       FROM agent_feedback WHERE spec_id = ?`
    )
    .get(spec.id) as { total: number; open: number | null };
  const pendingReviews = db
    .prepare("SELECT COUNT(*) AS n FROM change_requests WHERE spec_id = ? AND status = 'pending'")
    .get(spec.id) as { n: number };
  const recentUsage = db
    .prepare(
      `SELECT event_type, COUNT(*) AS n
       FROM usage_events
       WHERE created_at >= datetime('now', '-30 days')
         AND (? = 'global' OR project_type_id = ?)
       GROUP BY event_type`
    )
    .all(scope, spec.project_type_id) as Array<{ event_type: string; n: number }>;
  const score = Math.min(
    100,
    versionWeight(versionDelta) +
      Math.min(25, manifestConsumers.length * 3) +
      Math.min(15, subscriptions.length * 4) +
      Math.min(15, dependentSpecs.length * 5) +
      Math.min(10, Number(feedback.open ?? 0) * 2)
  );
  const usage = Object.fromEntries(recentUsage.map((row) => [row.event_type, row.n]));

  return {
    scope,
    level: levelFrom(score),
    score,
    summary: `${spec.filename} ${versionDelta} change affects ${manifestConsumers.length} reported project(s), ${subscriptions.length} subscribed repo(s), and ${dependentSpecs.length} dependent spec reference(s).`,
    affected_project_types: affectedProjectTypes,
    manifest_consumers: manifestConsumers,
    repo_subscriptions: subscriptions,
    dependent_specs: dependentSpecs,
    feedback: { total: Number(feedback.total ?? 0), open: Number(feedback.open ?? 0) },
    pending_reviews: Number(pendingReviews.n ?? 0),
    recent_usage: usage,
  };
}
