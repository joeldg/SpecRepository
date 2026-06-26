import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCodeInventory, writeCodeInventory } from "../src/codeMetadata.js";

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specreg-code-map-"));
  fs.mkdirSync(path.join(root, "src", "routes"), { recursive: true });
  fs.mkdirSync(path.join(root, "migrations"), { recursive: true });
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
    "CREATE TABLE users (id text primary key);\nCREATE UNIQUE INDEX idx_users_id ON users(id);\n",
    "utf8"
  );
  return root;
}

test("code inventory extracts AST metadata and stable IDs across supported languages", () => {
  const root = makeProject();
  const inventory = buildCodeInventory(root);
  const entities = inventory.entities;

  assert.equal(inventory.schema_version, 1);
  assert.deepEqual(inventory.languages, ["Python", "SQL", "TypeScript"]);
  assert.ok(entities.find((entity) => entity.kind === "class" && entity.name === "UserService"));
  assert.ok(entities.find((entity) => entity.kind === "interface" && entity.name === "UserDto"));
  assert.ok(entities.find((entity) => entity.kind === "function" && entity.name === "registerRoutes"));
  assert.ok(entities.find((entity) => entity.kind === "route" && entity.name === "GET /users/:id"));
  assert.ok(entities.find((entity) => entity.kind === "route" && entity.name === "POST /sessions"));
  assert.ok(entities.find((entity) => entity.kind === "schema" && entity.name === "users"));
  assert.ok(entities.find((entity) => entity.kind === "index" && entity.name === "idx_users_id"));

  const route = entities.find((entity) => entity.kind === "route" && entity.name === "GET /users/:id")!;
  assert.match(route.id, /^code:route:[a-f0-9]{16}$/);
  assert.equal(route.metadata?.method, "GET");
  assert.equal(route.metadata?.route_path, "/users/:id");

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
  assert.throws(() => writeCodeInventory({ root, out: ".spec/code-map.json", force: false }), /already exists/);
  const forced = writeCodeInventory({ root, out: ".spec/code-map.json", force: true });
  assert.equal(forced.entity_count, first.entity_count);
});
