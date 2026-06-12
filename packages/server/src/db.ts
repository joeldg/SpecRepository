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
  created_at TEXT NOT NULL
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
`;

export function createDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function now(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}
