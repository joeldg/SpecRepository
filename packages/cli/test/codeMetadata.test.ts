import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCodeInventory, writeCodeInventory } from "../src/codeMetadata.js";
import { evaluateTrace } from "../src/traceCheck.js";

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specreg-code-map-"));
  fs.mkdirSync(path.join(root, "src", "routes"), { recursive: true });
  fs.mkdirSync(path.join(root, "migrations"), { recursive: true });
  fs.mkdirSync(path.join(root, "specs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" }, dependencies: { fastify: "^5.0.0" } }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "src", "routes", "users.ts"),
    `import fastify from "fastify";

export interface UserDto {
  id: string;
}

export class UserService {
  findUser(id: string) {
    return id;
  }
}

export function registerRoutes(app: ReturnType<typeof fastify>) {
  app.get("/users/:id", async (req) => ({ ok: true }));
}
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "src", "api.py"),
    `from fastapi import FastAPI

app = FastAPI()

class SessionStore:
    def get(self, key: str):
        return key

@app.post("/sessions")
async def create_session():
    return {"ok": True}
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "migrations", "001_init.sql"),
    "CREATE TABLE users (id text primary key, email text not null);\nCREATE UNIQUE INDEX idx_users_id ON users(id);\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "specs", "API.md"),
    "# API\n\n## Routes\n\nThe service exposes GET /users/:id and POST /sessions.\n\n## Data\n\nThe users table stores id and email fields.\n",
    "utf8"
  );
  return root;
}

test("code inventory extracts AST metadata and stable IDs across supported languages", () => {
  const root = makeProject();
  const inventory = buildCodeInventory(root);
  const entities = inventory.entities;

  assert.equal(inventory.schema_version, 1);
  assert.deepEqual(inventory.languages, ["JSON", "Python", "SQL", "TypeScript"]);
  assert.ok(entities.find((entity) => entity.kind === "class" && entity.name === "UserService"));
  assert.ok(entities.find((entity) => entity.kind === "interface" && entity.name === "UserDto"));
  assert.ok(entities.find((entity) => entity.kind === "function" && entity.name === "registerRoutes"));
  assert.ok(entities.find((entity) => entity.kind === "route" && entity.name === "GET /users/:id"));
  assert.ok(entities.find((entity) => entity.kind === "route" && entity.name === "POST /sessions"));
  assert.ok(entities.find((entity) => entity.kind === "schema" && entity.name === "users"));
  assert.ok(entities.find((entity) => entity.kind === "field" && entity.name === "users.email"));
  assert.ok(entities.find((entity) => entity.kind === "index" && entity.name === "idx_users_id"));
  assert.ok(entities.find((entity) => entity.kind === "import" && entity.name === "fastify"));
  assert.ok(entities.find((entity) => entity.kind === "command" && entity.name === "test"));
  assert.ok(entities.find((entity) => entity.kind === "migration" && entity.name === "001_init.sql"));

  const route = entities.find((entity) => entity.kind === "route" && entity.name === "GET /users/:id")!;
  assert.match(route.id, /^code:route:[a-f0-9]{16}$/);
  assert.equal(route.metadata?.method, "GET");
  assert.equal(route.metadata?.route_path, "/users/:id");
  assert.equal(inventory.trace.spec_count, 1);
  assert.equal(inventory.trace.links.some((link) => link.entity_id === route.id && link.spec_filename === "API.md"), true);
  assert.equal(inventory.trace.coverage.linked_entity_count > 0, true);
  assert.equal(typeof inventory.trace.drift.score, "number");
  assert.equal(inventory.trace.unlinked_entities.every((entity) => typeof entity.start_line === "number"), true);

  const firstId = route.id;
  fs.writeFileSync(
    path.join(root, "src", "routes", "users.ts"),
    fs.readFileSync(path.join(root, "src", "routes", "users.ts"), "utf8").replace("ok: true", "ok: false"),
    "utf8"
  );
  const nextRoute = buildCodeInventory(root).entities.find((entity) => entity.kind === "route" && entity.name === "GET /users/:id")!;
  assert.equal(nextRoute.id, firstId);
  assert.notEqual(nextRoute.hash, route.hash);
});

test("code inventory writes a reviewable sidecar without overwriting unless forced", () => {
  const root = makeProject();
  const first = writeCodeInventory({ root, out: ".spec/code-map.json", force: false });
  assert.equal(first.entity_count > 0, true);
  assert.ok(fs.existsSync(path.join(root, ".spec", "code-map.json")));
  assert.ok(fs.existsSync(path.join(root, ".spec", "code-trace.json")));
  assert.throws(() => writeCodeInventory({ root, out: ".spec/code-map.json", force: false }), /already exists/);
  const forced = writeCodeInventory({ root, out: ".spec/code-map.json", force: true });
  assert.equal(forced.entity_count, first.entity_count);
  assert.equal(forced.trace.coverage.governed_entity_count, first.trace.coverage.governed_entity_count);
});

test("explicit @spec annotations create high-confidence trace links", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specreg-code-map-annotation-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "specs"), { recursive: true });
  fs.writeFileSync(path.join(root, "specs", "API.md"), "# API\n\n## Traceability\n\nHandlers are mapped explicitly.\n", "utf8");
  fs.writeFileSync(
    path.join(root, "src", "api.ts"),
    `// @spec[API.md#traceability]
export function handler() {
  return { ok: true };
}
`,
    "utf8"
  );

  const inventory = buildCodeInventory(root);
  const entity = inventory.entities.find((item) => item.kind === "function" && item.name === "handler")!;
  assert.deepEqual(entity.metadata?.spec_refs, ["API.md"]);
  assert.equal(
    inventory.trace.links.some(
      (link) =>
        link.entity_id === entity.id &&
        link.spec_filename === "API.md" &&
        link.confidence === 0.99 &&
        link.reasons.some((reason) => reason.includes("@spec"))
    ),
    true
  );
});

test("trace check fails low coverage, high drift, and unmapped critical entity kinds", () => {
  const root = makeProject();
  const inventory = buildCodeInventory(root);
  const findings = evaluateTrace(inventory.trace, {
    minCoverage: 0.95,
    maxDrift: 0.05,
    failOnUnmapped: ["route", "schema", "command"],
  });
  assert.equal(findings.some((finding) => finding.title === "Code-to-spec coverage below threshold"), true);
  assert.equal(findings.some((finding) => finding.title === "Code drift above threshold"), true);
  assert.equal(findings.some((finding) => finding.title.startsWith("Unmapped")), true);
});
