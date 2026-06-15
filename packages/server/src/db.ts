import Database from "better-sqlite3";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'project_type' CHECK (scope IN ('global', 'project_type')),
  industry TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS specs (
  id TEXT PRIMARY KEY,
  project_type_id TEXT NOT NULL REFERENCES project_types(id),
  filename TEXT NOT NULL,
  current_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_review', 'published')),
  content TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_type_id, filename)
);

CREATE TABLE IF NOT EXISTS spec_versions (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES specs(id),
  version TEXT NOT NULL,
  content TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL,
  UNIQUE (spec_id, version)
);

CREATE TABLE IF NOT EXISTS change_requests (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES specs(id),
  proposed_by TEXT NOT NULL,
  version_delta TEXT NOT NULL CHECK (version_delta IN ('major', 'minor', 'patch')),
  diff TEXT NOT NULL,
  proposed_content TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  resulting_version TEXT,
  compatibility TEXT,
  lint TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_approvals (
  id TEXT PRIMARY KEY,
  change_request_id TEXT NOT NULL REFERENCES change_requests(id),
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (change_request_id, reviewer)
);

CREATE TABLE IF NOT EXISTS approval_policies (
  id TEXT PRIMARY KEY,
  project_type_id TEXT REFERENCES project_types(id),
  filename_glob TEXT NOT NULL DEFAULT '*',
  min_approvals INTEGER NOT NULL DEFAULT 1 CHECK (min_approvals >= 1),
  required_reviewers TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_feedback (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES specs(id),
  spec_version TEXT NOT NULL,
  agent_identifier TEXT NOT NULL,
  error_type TEXT NOT NULL CHECK (error_type IN ('ambiguity', 'contradiction', 'outdated')),
  context_code_snippet TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stub_prompts (
  id TEXT PRIMARY KEY,
  target_filename TEXT NOT NULL,
  template TEXT NOT NULL,
  description TEXT,
  project_type_id TEXT REFERENCES project_types(id),
  UNIQUE (target_filename, project_type_id)
);

CREATE TABLE IF NOT EXISTS spec_templates (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  required_sections TEXT NOT NULL DEFAULT '[]',
  content_template TEXT NOT NULL DEFAULT '',
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('download', 'agent_read', 'search', 'stub_prompts', 'sync_check')),
  project_type_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_type_time ON usage_events(event_type, created_at);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',
  format TEXT NOT NULL DEFAULT 'json' CHECK (format IN ('json', 'slack', 'gchat')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repo_subscriptions (
  id TEXT PRIMARY KEY,
  project_type_id TEXT NOT NULL REFERENCES project_types(id),
  repo TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  base_path TEXT NOT NULL DEFAULT 'specs',
  created_at TEXT NOT NULL,
  UNIQUE (project_type_id, repo)
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES repo_subscriptions(id),
  spec_id TEXT NOT NULL REFERENCES specs(id),
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'error')),
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS spec_chunks USING fts5(
  spec_id UNINDEXED,
  section,
  content
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'author' CHECK (role IN ('admin', 'reviewer', 'author', 'agent')),
  password_hash TEXT,
  source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'ldap')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS efficacy_runs (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES specs(id),
  task_prompt TEXT NOT NULL,
  score_with INTEGER NOT NULL,
  score_without INTEGER NOT NULL,
  improved INTEGER NOT NULL,
  rationale TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  summary TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(created_at);
`;

/** Versioned migrations for databases created before the current schema. Each runs once. */
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: "ALTER TABLE change_requests ADD COLUMN compatibility TEXT" },
  { version: 2, sql: "ALTER TABLE change_requests ADD COLUMN lint TEXT" },
  { version: 3, sql: "ALTER TABLE spec_versions ADD COLUMN channel TEXT NOT NULL DEFAULT 'stable'" },
  { version: 4, sql: "ALTER TABLE project_types ADD COLUMN required_reviewers TEXT NOT NULL DEFAULT '[]'" },
  {
    // Widen the webhook format CHECK to admit 'gchat' (SQLite requires a rebuild).
    version: 5,
    sql: `
      ALTER TABLE webhooks RENAME TO webhooks_old;
      CREATE TABLE webhooks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        events TEXT NOT NULL DEFAULT '[]',
        format TEXT NOT NULL DEFAULT 'json' CHECK (format IN ('json', 'slack', 'gchat')),
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      INSERT INTO webhooks SELECT * FROM webhooks_old;
      DROP TABLE webhooks_old;
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS review_approvals (
        id TEXT PRIMARY KEY,
        change_request_id TEXT NOT NULL REFERENCES change_requests(id),
        reviewer TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (change_request_id, reviewer)
      );
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS approval_policies (
        id TEXT PRIMARY KEY,
        project_type_id TEXT REFERENCES project_types(id),
        filename_glob TEXT NOT NULL DEFAULT '*',
        min_approvals INTEGER NOT NULL DEFAULT 1 CHECK (min_approvals >= 1),
        required_reviewers TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        summary TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(created_at);
    `,
  },
];

export function createDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  const row = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  let version = row ? Number(row.value) : 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    try {
      db.exec(migration.sql);
    } catch {
      // already satisfied by the fresh-schema definition (e.g. column exists)
    }
    version = migration.version;
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)").run(String(version));
  return db;
}

export function now(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}
