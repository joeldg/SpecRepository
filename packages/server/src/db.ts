import Database from "better-sqlite3";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'project_type' CHECK (scope IN ('global', 'project_type')),
  industry TEXT,
  description TEXT,
  required_reviewers TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS specs (
  id TEXT PRIMARY KEY,
  project_type_id TEXT NOT NULL REFERENCES project_types(id),
  project_id TEXT REFERENCES repo_consumers(id),
  filename TEXT NOT NULL,
  current_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_review', 'published')),
  content TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  audit_prompt TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_specs_type_filename ON specs(project_type_id, filename) WHERE project_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_specs_project_filename ON specs(project_id, filename) WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS spec_versions (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES specs(id),
  version TEXT NOT NULL,
  content TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'stable',
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
  contradictions TEXT,
  risk TEXT,
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

-- spec_id/spec_version are nullable: a 'missing_guidance' report flags a coverage
-- gap (no governing spec exists yet) rather than a problem with an existing one.
CREATE TABLE IF NOT EXISTS agent_feedback (
  id TEXT PRIMARY KEY,
  spec_id TEXT REFERENCES specs(id),
  spec_version TEXT,
  agent_identifier TEXT NOT NULL,
  error_type TEXT NOT NULL CHECK (error_type IN ('ambiguity', 'contradiction', 'outdated', 'missing_guidance')),
  context_code_snippet TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  project_type_id TEXT REFERENCES project_types(id),
  languages TEXT,
  topic TEXT,
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

CREATE TABLE IF NOT EXISTS repo_consumers (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  branch TEXT,
  commit_sha TEXT,
  project_type_id TEXT NOT NULL REFERENCES project_types(id),
  specs_path TEXT NOT NULL DEFAULT 'specs',
  manifest_path TEXT NOT NULL DEFAULT 'specs/.specregistry.json',
  source TEXT NOT NULL DEFAULT 'cli',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (repo, project_type_id)
);

CREATE TABLE IF NOT EXISTS repo_consumer_specs (
  consumer_id TEXT NOT NULL REFERENCES repo_consumers(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  version TEXT NOT NULL,
  project_type TEXT,
  sha256 TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (consumer_id, filename)
);

CREATE TABLE IF NOT EXISTS code_trace_reports (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES repo_consumers(id) ON DELETE CASCADE,
  generated_at TEXT NOT NULL,
  specs_dir TEXT NOT NULL DEFAULT 'specs',
  spec_count INTEGER NOT NULL DEFAULT 0,
  entity_count INTEGER NOT NULL DEFAULT 0,
  governed_entity_count INTEGER NOT NULL DEFAULT 0,
  linked_entity_count INTEGER NOT NULL DEFAULT 0,
  unlinked_entity_count INTEGER NOT NULL DEFAULT 0,
  coverage_ratio REAL NOT NULL DEFAULT 0,
  drift_score REAL NOT NULL DEFAULT 0,
  drift_severity TEXT NOT NULL DEFAULT 'none',
  aliases_count INTEGER NOT NULL DEFAULT 0,
  unlinked_sample TEXT NOT NULL DEFAULT '[]',
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_trace_reports_consumer_time ON code_trace_reports(consumer_id, created_at);

CREATE TABLE IF NOT EXISTS code_trace_links (
  report_id TEXT NOT NULL REFERENCES code_trace_reports(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  spec_filename TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  reasons TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (report_id, entity_id, spec_filename)
);
CREATE INDEX IF NOT EXISTS idx_code_trace_links_report ON code_trace_links(report_id);

CREATE VIRTUAL TABLE IF NOT EXISTS spec_chunks USING fts5(
  spec_id UNINDEXED,
  section,
  content
);

CREATE TABLE IF NOT EXISTS spec_embeddings (
  spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  section_anchor TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (spec_id, section_anchor, provider, model)
);
CREATE INDEX IF NOT EXISTS idx_spec_embeddings_provider_model ON spec_embeddings(provider, model);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'author' CHECK (role IN ('admin', 'reviewer', 'author', 'agent')),
  password_hash TEXT,
  source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'ldap')),
  repo TEXT,
  project_type_id TEXT,
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

CREATE TABLE IF NOT EXISTS agent_skills (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'safe' CHECK (risk_level IN ('safe', 'restricted')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  built_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS harness_proposals (
  id TEXT PRIMARY KEY,
  pattern_key TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT 'agent_skill' CHECK (target_type IN ('agent_skill')),
  target_id TEXT NOT NULL REFERENCES agent_skills(id),
  target_slug TEXT NOT NULL,
  current_instructions TEXT NOT NULL,
  proposed_instructions TEXT NOT NULL,
  proposed_addition TEXT NOT NULL,
  validation_gate TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  proposed_by TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_harness_proposals_status_time ON harness_proposals(status, created_at);

CREATE TABLE IF NOT EXISTS compliance_policies (
  id TEXT PRIMARY KEY,
  project_type_id TEXT UNIQUE,
  min_coverage REAL NOT NULL DEFAULT 0.8,
  max_drift REAL NOT NULL DEFAULT 0.2,
  required_mapped_kinds TEXT NOT NULL DEFAULT '["route","schema"]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS compliance_attestations (
  id TEXT PRIMARY KEY,
  project_type_id TEXT,
  consumer_id TEXT,
  repo TEXT,
  self_assessed_score INTEGER,
  objective_score INTEGER NOT NULL,
  compliant INTEGER NOT NULL,
  coverage_ratio REAL,
  drift_score REAL,
  outstanding TEXT NOT NULL DEFAULT '[]',
  iteration INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compliance_attestations_repo ON compliance_attestations(repo, created_at);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  agent_identifier TEXT NOT NULL,
  project_type_id TEXT,
  consumer_id TEXT,
  repo TEXT,
  branch TEXT,
  task TEXT NOT NULL,
  model TEXT,
  mcp_server TEXT,
  spec_count INTEGER NOT NULL DEFAULT 0,
  spec_bundle TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'blocked')),
  plan TEXT,
  preflight_summary TEXT,
  completion_summary TEXT,
  compliance_attestation_id TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_repo_time ON agent_sessions(repo, started_at);
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
  { version: 9, sql: "ALTER TABLE change_requests ADD COLUMN contradictions TEXT" },
  {
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS repo_consumers (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        branch TEXT,
        commit_sha TEXT,
        project_type_id TEXT NOT NULL REFERENCES project_types(id),
        specs_path TEXT NOT NULL DEFAULT 'specs',
        manifest_path TEXT NOT NULL DEFAULT 'specs/.specregistry.json',
        source TEXT NOT NULL DEFAULT 'cli',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE (repo, project_type_id)
      );
      CREATE TABLE IF NOT EXISTS repo_consumer_specs (
        consumer_id TEXT NOT NULL REFERENCES repo_consumers(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        version TEXT NOT NULL,
        project_type TEXT,
        sha256 TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (consumer_id, filename)
      );
    `,
  },
  {
    version: 11,
    sql: `
      PRAGMA foreign_keys = OFF;
      DROP TABLE IF EXISTS specs_new;
      CREATE TABLE specs_new (
        id TEXT PRIMARY KEY,
        project_type_id TEXT NOT NULL REFERENCES project_types(id),
        project_id TEXT REFERENCES repo_consumers(id),
        filename TEXT NOT NULL,
        current_version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_review', 'published')),
        content TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO specs_new
        (id, project_type_id, project_id, filename, current_version, status, content, updated_by, created_at, updated_at)
        SELECT id, project_type_id, NULL, filename, current_version, status, content, updated_by, created_at, updated_at
        FROM specs;
      DROP TABLE specs;
      ALTER TABLE specs_new RENAME TO specs;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_specs_type_filename ON specs(project_type_id, filename) WHERE project_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_specs_project_filename ON specs(project_id, filename) WHERE project_id IS NOT NULL;
      PRAGMA foreign_keys = ON;
    `,
  },
  { version: 12, sql: "ALTER TABLE change_requests ADD COLUMN risk TEXT" },
  {
    version: 13,
    sql: `
      CREATE TABLE IF NOT EXISTS spec_embeddings (
        spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
        section TEXT NOT NULL,
        section_anchor TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (spec_id, section_anchor, provider, model)
      );
      CREATE INDEX IF NOT EXISTS idx_spec_embeddings_provider_model ON spec_embeddings(provider, model);
    `,
  },
  {
    version: 14,
    sql: `
      CREATE TABLE IF NOT EXISTS agent_skills (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        risk_level TEXT NOT NULL DEFAULT 'safe' CHECK (risk_level IN ('safe', 'restricted')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        built_in INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 15,
    sql: "ALTER TABLE specs ADD COLUMN audit_prompt TEXT"
  },
  {
    version: 16,
    sql: "ALTER TABLE specs ADD COLUMN deleted_at TEXT"
  },
  {
    version: 17,
    sql: `
      CREATE TABLE IF NOT EXISTS code_trace_reports (
        id TEXT PRIMARY KEY,
        consumer_id TEXT NOT NULL REFERENCES repo_consumers(id) ON DELETE CASCADE,
        generated_at TEXT NOT NULL,
        specs_dir TEXT NOT NULL DEFAULT 'specs',
        spec_count INTEGER NOT NULL DEFAULT 0,
        entity_count INTEGER NOT NULL DEFAULT 0,
        governed_entity_count INTEGER NOT NULL DEFAULT 0,
        linked_entity_count INTEGER NOT NULL DEFAULT 0,
        unlinked_entity_count INTEGER NOT NULL DEFAULT 0,
        coverage_ratio REAL NOT NULL DEFAULT 0,
        drift_score REAL NOT NULL DEFAULT 0,
        drift_severity TEXT NOT NULL DEFAULT 'none',
        aliases_count INTEGER NOT NULL DEFAULT 0,
        unlinked_sample TEXT NOT NULL DEFAULT '[]',
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_code_trace_reports_consumer_time ON code_trace_reports(consumer_id, created_at);
      CREATE TABLE IF NOT EXISTS code_trace_links (
        report_id TEXT NOT NULL REFERENCES code_trace_reports(id) ON DELETE CASCADE,
        entity_id TEXT NOT NULL,
        entity_name TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        spec_filename TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        reasons TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (report_id, entity_id, spec_filename)
      );
      CREATE INDEX IF NOT EXISTS idx_code_trace_links_report ON code_trace_links(report_id);
    `,
  },
  {
    // Bind self-enrolled agent identities to a repo + project type so they can
    // self-publish project-scoped specs for their own repo only.
    version: 18,
    sql: `
      ALTER TABLE users ADD COLUMN repo TEXT;
      ALTER TABLE users ADD COLUMN project_type_id TEXT;
    `,
  },
  {
    // Compliance verification loop: per-project-type thresholds + attestation log.
    version: 19,
    sql: `
      CREATE TABLE IF NOT EXISTS compliance_policies (
        id TEXT PRIMARY KEY,
        project_type_id TEXT UNIQUE,
        min_coverage REAL NOT NULL DEFAULT 0.8,
        max_drift REAL NOT NULL DEFAULT 0.2,
        required_mapped_kinds TEXT NOT NULL DEFAULT '["route","schema"]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS compliance_attestations (
        id TEXT PRIMARY KEY,
        project_type_id TEXT,
        consumer_id TEXT,
        repo TEXT,
        self_assessed_score INTEGER,
        objective_score INTEGER NOT NULL,
        compliant INTEGER NOT NULL,
        coverage_ratio REAL,
        drift_score REAL,
        outstanding TEXT NOT NULL DEFAULT '[]',
        iteration INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_compliance_attestations_repo ON compliance_attestations(repo, created_at);
    `,
  },
  {
    // Agent lifecycle registry for MCP begin_task / finish_task control points.
    version: 20,
    sql: `
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        agent_identifier TEXT NOT NULL,
        project_type_id TEXT,
        consumer_id TEXT,
        repo TEXT,
        branch TEXT,
        task TEXT NOT NULL,
        model TEXT,
        mcp_server TEXT,
        spec_count INTEGER NOT NULL DEFAULT 0,
        spec_bundle TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'blocked')),
        plan TEXT,
        preflight_summary TEXT,
        completion_summary TEXT,
        compliance_attestation_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_repo_time ON agent_sessions(repo, started_at);
    `,
  },
  {
    // Widen agent_feedback to admit spec_id-less "missing_guidance" gap reports
    // (SQLite requires a rebuild to relax NOT NULL and widen the error_type CHECK).
    version: 21,
    sql: `
      ALTER TABLE agent_feedback RENAME TO agent_feedback_old;
      CREATE TABLE agent_feedback (
        id TEXT PRIMARY KEY,
        spec_id TEXT REFERENCES specs(id),
        spec_version TEXT,
        agent_identifier TEXT NOT NULL,
        error_type TEXT NOT NULL CHECK (error_type IN ('ambiguity', 'contradiction', 'outdated', 'missing_guidance')),
        context_code_snippet TEXT,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
        project_type_id TEXT REFERENCES project_types(id),
        languages TEXT,
        topic TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO agent_feedback
        (id, spec_id, spec_version, agent_identifier, error_type, context_code_snippet, description, status, created_at)
        SELECT id, spec_id, spec_version, agent_identifier, error_type, context_code_snippet, description, status, created_at
        FROM agent_feedback_old;
      DROP TABLE agent_feedback_old;
    `,
  },
  {
    // Correct the built-in load-governed-specs skill so it points agents at begin_task
    // first (matching the AGENT_OPERATING_RULES governed spec). Gated on the exact old
    // shipped text so an admin who has customized this built-in skill keeps their edit.
    // New default skills added alongside this ship via seedDefaultAgentSkills (INSERT
    // OR IGNORE), which runs on every startup.
    version: 22,
    sql: `
      UPDATE agent_skills
      SET instructions = 'Before non-trivial work, call begin_task to register the session, then use the SpecRegistry MCP get_specs tool for the configured project type and repository to load the governed bundle. Check the local manifest for drift. Treat published specs as authoritative and do not treat drafts as approved guidance.',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE slug = 'load-governed-specs'
        AND built_in = 1
        AND instructions = 'Before non-trivial work, use the SpecRegistry MCP get_specs tool for the configured project type and repository. Check the local manifest for drift. Treat published specs as authoritative and do not treat drafts as approved guidance.';
    `,
  },
  {
    version: 23,
    sql: "ALTER TABLE agent_feedback ADD COLUMN project_type_id TEXT REFERENCES project_types(id)",
  },
  {
    version: 24,
    sql: "ALTER TABLE agent_feedback ADD COLUMN languages TEXT",
  },
  {
    version: 25,
    sql: "ALTER TABLE agent_feedback ADD COLUMN topic TEXT",
  },
  {
    version: 26,
    sql: `
      CREATE TABLE IF NOT EXISTS harness_proposals (
        id TEXT PRIMARY KEY,
        pattern_key TEXT NOT NULL,
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        target_type TEXT NOT NULL DEFAULT 'agent_skill' CHECK (target_type IN ('agent_skill')),
        target_id TEXT NOT NULL REFERENCES agent_skills(id),
        target_slug TEXT NOT NULL,
        current_instructions TEXT NOT NULL,
        proposed_instructions TEXT NOT NULL,
        proposed_addition TEXT NOT NULL,
        validation_gate TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        proposed_by TEXT NOT NULL,
        reviewed_by TEXT,
        reviewed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_harness_proposals_status_time ON harness_proposals(status, created_at);
    `,
  },
];

const DEFAULT_AGENT_SKILLS = [
  {
    slug: "register-task-session",
    name: "Register the task session",
    description: "Open a governed agent session with begin_task before doing non-trivial implementation work.",
    instructions: "Before non-trivial work, call begin_task with the concrete task, a short plan, the model in use, and the spec files you intend to load. Resolve any returned blockers before editing, follow the declared plan, and keep the returned session_id to pass to finish_task when the work is complete.",
  },
  {
    slug: "load-governed-specs",
    name: "Load governed specs",
    description: "Load the current global, project-type, and project-scoped specifications before implementation work.",
    instructions: "Before non-trivial work, call begin_task to register the session, then use the SpecRegistry MCP get_specs tool for the configured project type and repository to load the governed bundle. Check the local manifest for drift. Treat published specs as authoritative and do not treat drafts as approved guidance.",
  },
  {
    slug: "resolve-uncovered-guidance",
    name: "Resolve uncovered guidance",
    description: "Pull governed guidance before writing in a language or domain the loaded specs do not cover.",
    instructions: "Before writing in a language, or working in a domain (networking, authentication, database, deployment) the loaded specs do not clearly cover, call resolve_guidance. Pull the styleguides and specs it returns. If it reports a coverage gap, call report_spec_feedback with error_type missing_guidance plus the relevant languages/topic instead of inventing a standard.",
  },
  {
    slug: "search-spec-context",
    name: "Search spec context",
    description: "Find focused governing sections without injecting the entire spec set into context.",
    instructions: "Use search_specs in hybrid mode with concrete task terms, filenames, APIs, security concerns, and acceptance criteria. Cite the returned spec and section. Load full documents only when the focused sections are insufficient.",
  },
  {
    slug: "report-spec-problems",
    name: "Report spec problems",
    description: "Report ambiguity, contradiction, or outdated guidance instead of guessing around it.",
    instructions: "When guidance is ambiguous, contradictory, incomplete, or outdated, stop the affected decision and call report_spec_feedback. Include the spec, section, task, conflicting evidence, and the decision that needs clarification.",
  },
  {
    slug: "plan-from-specs",
    name: "Plan from specs",
    description: "Turn governed requirements into an implementation plan and acceptance evidence.",
    instructions: "Identify applicable specs and acceptance criteria before editing. Produce a concise plan that maps each implementation step and verification step to governing requirements. Call out missing coverage rather than inventing requirements.",
  },
  {
    slug: "verify-conformance",
    name: "Verify conformance",
    description: "Check implementation results against the current governed specification set.",
    instructions: "After implementation, run relevant tests and a reverse conformance check. Compare behavior, configuration, interfaces, and operational evidence with the current specs. Report violations and intent mismatches separately.",
  },
  {
    slug: "collect-delivery-evidence",
    name: "Collect delivery evidence",
    description: "Record the tests, checks, and operational evidence that support a completed change.",
    instructions: "Summarize commands run, test outcomes, affected specs, known residual risks, and any unverified requirement. Do not claim a check passed unless it was actually executed and its result observed.",
  },
  {
    slug: "run-compliance-loop",
    name: "Run the compliance loop",
    description: "Confirm objective compliance before claiming a task is complete, and keep working until it passes.",
    instructions: "Before declaring a task done, call finish_task with your session_id (or check_compliance, or run specreg comply for CLI/CI). If it is not compliant, keep remediating and re-run — a self-assessed 'done' is not sufficient. Do not report completion while the objective coverage/drift gate still reports outstanding items.",
  },
  {
    slug: "propose-not-publish",
    name: "Propose, do not self-approve",
    description: "Propose changes to governed specs through review; never approve or publish your own change.",
    instructions: "You may create, edit, and publish project-scoped specs for your own enrolled repo, but only propose changes to global and project-type specs through the review workflow. Never approve or publish a change you proposed — approval is a separate human action. Authenticate only as your own enrolled agent identity and stay within the documented MCP tools and the specreg CLI.",
  },
] as const;

function seedDefaultAgentSkills(db: Db): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO agent_skills
      (id, slug, name, description, instructions, risk_level, status, built_in, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'safe', 'active', 1, ?, ?)`
  );
  const ts = now();
  for (const skill of DEFAULT_AGENT_SKILLS) {
    insert.run(`builtin-${skill.slug}`, skill.slug, skill.name, skill.description, skill.instructions, ts, ts);
  }
}

export function createDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const hasSpecs = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'specs'").get());
  if (hasSpecs) {
    const specsColumns = db.prepare("PRAGMA table_info(specs)").all() as Array<{ name: string }>;
    if (!specsColumns.some((column) => column.name === "project_id")) {
      db.exec("ALTER TABLE specs ADD COLUMN project_id TEXT REFERENCES repo_consumers(id)");
    }
  }
  const hasChangeRequests = Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'change_requests'").get()
  );
  if (hasChangeRequests) {
    const changeColumns = db.prepare("PRAGMA table_info(change_requests)").all() as Array<{ name: string }>;
    if (!changeColumns.some((column) => column.name === "risk")) {
      db.exec("ALTER TABLE change_requests ADD COLUMN risk TEXT");
    }
  }
  const hasSettings = Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()
  );
  db.exec(SCHEMA);
  const row = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  let version = row ? Number(row.value) : hasSettings ? 0 : MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
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
  seedDefaultAgentSkills(db);
  return db;
}

export function now(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}
