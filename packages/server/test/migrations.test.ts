import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db.js";

const OLD_LOAD_SPECS_TEXT =
  "Before non-trivial work, use the SpecRegistry MCP get_specs tool for the configured project type and repository. Check the local manifest for drift. Treat published specs as authoritative and do not treat drafts as approved guidance.";

const NEW_DEFAULT_SLUGS = [
  "register-task-session",
  "resolve-uncovered-guidance",
  "run-compliance-loop",
  "propose-not-publish",
];

const tmpDirs: string[] = [];
function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specreg-mig-"));
  tmpDirs.push(dir);
  return path.join(dir, "registry.db");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
});

// Simulate a database created before the v22 skill migration: revert load-governed-specs
// to its old shipped text, drop the newer default skills, and roll schema_version back so
// the next createDb re-runs the migration and re-seeds.
function downgradeToPreV22(dbPath: string, loadSpecsText: string): void {
  const db = createDb(dbPath);
  db.prepare("UPDATE agent_skills SET instructions = ? WHERE slug = 'load-governed-specs'").run(loadSpecsText);
  db.prepare(`DELETE FROM agent_skills WHERE slug IN (${NEW_DEFAULT_SLUGS.map(() => "?").join(", ")})`).run(...NEW_DEFAULT_SLUGS);
  db.prepare("UPDATE settings SET value = '21' WHERE key = 'schema_version'").run();
  db.close();
}

describe("agent skill migration (v22)", () => {
  it("corrects the shipped load-governed-specs text and seeds the new default skills on an existing database", () => {
    const dbPath = tmpDbPath();
    downgradeToPreV22(dbPath, OLD_LOAD_SPECS_TEXT);

    const db = createDb(dbPath);
    const load = db.prepare("SELECT instructions FROM agent_skills WHERE slug = 'load-governed-specs'").get() as {
      instructions: string;
    };
    expect(load.instructions).toContain("begin_task");

    for (const slug of NEW_DEFAULT_SLUGS) {
      const row = db.prepare("SELECT risk_level, built_in, status FROM agent_skills WHERE slug = ?").get(slug);
      expect(row).toMatchObject({ risk_level: "safe", built_in: 1, status: "active" });
    }
    db.close();
  });

  it("does not clobber a load-governed-specs skill an admin has customized", () => {
    const dbPath = tmpDbPath();
    const custom = "CUSTOM admin instructions that must survive the upgrade.";
    downgradeToPreV22(dbPath, custom);

    const db = createDb(dbPath);
    const load = db.prepare("SELECT instructions FROM agent_skills WHERE slug = 'load-governed-specs'").get() as {
      instructions: string;
    };
    expect(load.instructions).toBe(custom);
    db.close();
  });
});

describe("agent feedback gap metadata migrations", () => {
  it("adds project_type_id/languages/topic to databases that already passed the v21 feedback rebuild", () => {
    const dbPath = tmpDbPath();
    const setup = createDb(dbPath);
    setup.exec(`
      PRAGMA foreign_keys = OFF;
      ALTER TABLE agent_feedback RENAME TO agent_feedback_current;
      CREATE TABLE agent_feedback (
        id TEXT PRIMARY KEY,
        spec_id TEXT REFERENCES specs(id),
        spec_version TEXT,
        agent_identifier TEXT NOT NULL,
        error_type TEXT NOT NULL CHECK (error_type IN ('ambiguity', 'contradiction', 'outdated', 'missing_guidance')),
        context_code_snippet TEXT,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
        created_at TEXT NOT NULL
      );
      DROP TABLE agent_feedback_current;
      PRAGMA foreign_keys = ON;
      UPDATE settings SET value = '22' WHERE key = 'schema_version';
    `);
    setup.close();

    const migrated = createDb(dbPath);
    const columns = migrated.prepare("PRAGMA table_info(agent_feedback)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["project_type_id", "languages", "topic"])
    );
    migrated.close();
  });
});
