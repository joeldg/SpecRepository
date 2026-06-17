# SpecRegistry Metrics

SpecRegistry exposes Prometheus text-format metrics at `GET /metrics`. The endpoint is
registered in `packages/server/src/routes/metrics.ts` and is intentionally public so
Prometheus, Grafana Alloy, or another scraper can collect metrics even when
`SPECREG_AUTH=required`.

The metrics route does not keep an in-memory registry. Each scrape reads the current
SQLite state through `app.db`, runs a small set of aggregate queries, and renders the
result as Prometheus `# HELP`, `# TYPE`, and sample lines. This means samples represent
the database state at scrape time.

## Runtime Metric

| Metric | Type | Labels | Generated from | Meaning |
| --- | --- | --- | --- | --- |
| `specregistry_info` | gauge | `version` | Static row in `metricsRoutes`; currently `version="0.1.0"` | Build/runtime identity. Value is always `1` for the running service version. |

## SDD Governance Metrics

| Metric | Type | Labels | Generated from | Meaning |
| --- | --- | --- | --- | --- |
| `specregistry_specs_total` | gauge | `status`, `scope` | `SELECT s.status, pt.scope, COUNT(*) AS n FROM specs s JOIN project_types pt ON pt.id = s.project_type_id GROUP BY s.status, pt.scope` | Number of specs in each lifecycle status, grouped by global/project/project-specific scope. |
| `specregistry_reviews_total` | gauge | `status` | `SELECT status, COUNT(*) AS n FROM change_requests GROUP BY status` | Number of spec change requests in each review state. |
| `specregistry_oldest_pending_review_age_seconds` | gauge | none | Oldest `created_at` from `change_requests` where `status = 'pending'`; rendered as `Date.now() - created_at` in seconds | Age of the oldest pending review. Emits `0` when no reviews are pending. |
| `specregistry_approval_policies_total` | gauge | none | Count from `approval_policies` in the combined counts query | Number of approval policies configured in the registry. |
| `specregistry_audit_events_total` | gauge | none | Count from `audit_log` in the combined counts query | Number of persisted audit log events. This tracks governance activity volume. |

## Feedback and Efficacy Metrics

| Metric | Type | Labels | Generated from | Meaning |
| --- | --- | --- | --- | --- |
| `specregistry_feedback_total` | gauge | `status`, `error_type` | `SELECT status, error_type, COUNT(*) AS n FROM agent_feedback GROUP BY status, error_type` | Agent feedback volume grouped by workflow status and feedback/error type. |
| `specregistry_efficacy_runs_total` | gauge | none | Count from `efficacy_runs` in the combined counts query | Number of AI efficacy checks recorded. |
| `specregistry_efficacy_improved_runs_total` | gauge | none | Count from `efficacy_runs WHERE improved = 1` in the combined counts query | Number of efficacy runs where the spec-guided output improved the measured result. |

## Usage and Distribution Metrics

| Metric | Type | Labels | Generated from | Meaning |
| --- | --- | --- | --- | --- |
| `specregistry_usage_events_total` | counter | `event_type` | `SELECT event_type, COUNT(*) AS n FROM usage_events GROUP BY event_type` | Number of recorded usage events, grouped by event type such as downloads, searches, bundle generation, or agent activity. Although rendered as a counter, it is derived from database rows and can reset if the database is reset or pruned. |
| `specregistry_sync_jobs_total` | gauge | `status` | `SELECT status, COUNT(*) AS n FROM sync_jobs GROUP BY status` | Repository sync jobs grouped by status. |
| `specregistry_project_types_total` | gauge | none | Count from `project_types` in the combined counts query | Number of project type records, including global scopes and project/consumer scopes. |
| `specregistry_subscriptions_total` | gauge | none | Count from `repo_subscriptions` in the combined counts query | Number of repository subscription records. |

## Platform and Integration Metrics

| Metric | Type | Labels | Generated from | Meaning |
| --- | --- | --- | --- | --- |
| `specregistry_users_total` | gauge | `role`, `source` | `SELECT role, source, COUNT(*) AS n FROM users GROUP BY role, source` | Number of users grouped by application role and identity source, such as local or LDAP. |
| `specregistry_active_webhooks_total` | gauge | none | Count from `webhooks WHERE active = 1` in the combined counts query | Number of active webhook integrations. |

## Scraping Locally

```sh
curl http://localhost:4000/metrics
```

Example response fragment:

```text
# HELP specregistry_specs_total Number of specifications by status and scope.
# TYPE specregistry_specs_total gauge
specregistry_specs_total{status="published",scope="global"} 3
```

## Scraping with Grafana Alloy

The Docker Compose metrics profile starts Grafana Alloy with
`config/alloy/config.alloy`. Alloy scrapes `specregistry:4000/metrics` inside the
Compose network and remote-writes samples to the configured endpoint.

```sh
GRAFANA_REMOTE_WRITE_URL=https://prometheus-prod-xx.grafana.net/api/prom/push \
GRAFANA_REMOTE_WRITE_USERNAME=<instance-id> \
GRAFANA_REMOTE_WRITE_PASSWORD=<api-token> \
docker compose --profile metrics up --build
```

## Adding a Metric

1. Add the aggregate query and rendered sample in `packages/server/src/routes/metrics.ts`.
2. Keep labels bounded; avoid repository names, spec filenames, raw users, or other
   high-cardinality values unless there is a deliberate observability need.
3. Add or update coverage in `packages/server/test/api.test.ts`.
4. Update this file and the short list in `README.md`.

