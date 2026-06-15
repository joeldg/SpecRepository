import type { FastifyInstance } from "fastify";

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function labels(values: Record<string, string | number | null | undefined>): string {
  const entries = Object.entries(values).filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== undefined);
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(String(value))}"`).join(",")}}`;
}

function metric(name: string, help: string, type: "counter" | "gauge", rows: string[]): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...rows];
}

function single(name: string, value: number, labelValues: Record<string, string | number | null | undefined> = {}): string {
  return `${name}${labels(labelValues)} ${value}`;
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async (_req, reply) => {
    const db = app.db;
    const lines: string[] = [];
    lines.push(
      ...metric("specregistry_info", "SpecRegistry build/runtime information.", "gauge", [
        single("specregistry_info", 1, { version: "0.1.0" }),
      ])
    );

    const specs = db
      .prepare(
        `SELECT s.status, pt.scope, COUNT(*) AS n
         FROM specs s JOIN project_types pt ON pt.id = s.project_type_id
         GROUP BY s.status, pt.scope`
      )
      .all() as Array<{ status: string; scope: string; n: number }>;
    lines.push(
      ...metric(
        "specregistry_specs_total",
        "Number of specifications by status and scope.",
        "gauge",
        specs.map((row) => single("specregistry_specs_total", row.n, { status: row.status, scope: row.scope }))
      )
    );

    const reviews = db.prepare("SELECT status, COUNT(*) AS n FROM change_requests GROUP BY status").all() as Array<{
      status: string;
      n: number;
    }>;
    lines.push(
      ...metric(
        "specregistry_reviews_total",
        "Number of change requests by status.",
        "gauge",
        reviews.map((row) => single("specregistry_reviews_total", row.n, { status: row.status }))
      )
    );

    const pendingAge = db
      .prepare("SELECT created_at FROM change_requests WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1")
      .get() as { created_at: string } | undefined;
    lines.push(
      ...metric("specregistry_oldest_pending_review_age_seconds", "Age of the oldest pending review.", "gauge", [
        single(
          "specregistry_oldest_pending_review_age_seconds",
          pendingAge ? Math.max(0, Math.floor((Date.now() - Date.parse(pendingAge.created_at)) / 1000)) : 0
        ),
      ])
    );

    const feedback = db
      .prepare("SELECT status, error_type, COUNT(*) AS n FROM agent_feedback GROUP BY status, error_type")
      .all() as Array<{ status: string; error_type: string; n: number }>;
    lines.push(
      ...metric(
        "specregistry_feedback_total",
        "Agent feedback items by status and error type.",
        "gauge",
        feedback.map((row) => single("specregistry_feedback_total", row.n, { status: row.status, error_type: row.error_type }))
      )
    );

    const usage = db.prepare("SELECT event_type, COUNT(*) AS n FROM usage_events GROUP BY event_type").all() as Array<{
      event_type: string;
      n: number;
    }>;
    lines.push(
      ...metric(
        "specregistry_usage_events_total",
        "Recorded usage events by type.",
        "counter",
        usage.map((row) => single("specregistry_usage_events_total", row.n, { event_type: row.event_type }))
      )
    );

    const syncJobs = db.prepare("SELECT status, COUNT(*) AS n FROM sync_jobs GROUP BY status").all() as Array<{
      status: string;
      n: number;
    }>;
    lines.push(
      ...metric(
        "specregistry_sync_jobs_total",
        "Repository sync jobs by status.",
        "gauge",
        syncJobs.map((row) => single("specregistry_sync_jobs_total", row.n, { status: row.status }))
      )
    );

    const users = db.prepare("SELECT role, source, COUNT(*) AS n FROM users GROUP BY role, source").all() as Array<{
      role: string;
      source: string;
      n: number;
    }>;
    lines.push(
      ...metric(
        "specregistry_users_total",
        "Users by role and source.",
        "gauge",
        users.map((row) => single("specregistry_users_total", row.n, { role: row.role, source: row.source }))
      )
    );

    const counts = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM project_types) AS project_types,
          (SELECT COUNT(*) FROM webhooks WHERE active = 1) AS active_webhooks,
          (SELECT COUNT(*) FROM repo_subscriptions) AS subscriptions,
          (SELECT COUNT(*) FROM approval_policies) AS approval_policies,
          (SELECT COUNT(*) FROM audit_log) AS audit_events,
          (SELECT COUNT(*) FROM efficacy_runs) AS efficacy_runs,
          (SELECT COUNT(*) FROM efficacy_runs WHERE improved = 1) AS efficacy_improved_runs`
      )
      .get() as Record<string, number>;
    for (const [key, value] of Object.entries(counts)) {
      lines.push(
        ...metric(`specregistry_${key}_total`, `SpecRegistry ${key.replace(/_/g, " ")} total.`, "gauge", [
          single(`specregistry_${key}_total`, value),
        ])
      );
    }

    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return `${lines.join("\n")}\n`;
  });
}
