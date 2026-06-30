import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSubmitDrafts } from "../src/submitDrafts.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("submit-drafts publish message tells users to sync created project specs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specreg-submit-drafts-"));
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs: string[] = [];
  fs.mkdirSync(path.join(root, ".spec", "drafts"), { recursive: true });
  fs.writeFileSync(path.join(root, ".spec", "drafts", "API.md"), "# API\n\n## Scope\n\nProject API.\n", "utf8");
  process.chdir(root);
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/project-types") {
      return json([{ id: "type-1", name: "Web App Standard", scope: "project_type", created_at: "", updated_at: "" }]);
    }
    if (url.pathname === "/api/v1/cli/manifest-report") return json({ project_id: "project-1" });
    if (url.pathname === "/api/v1/specs" && url.searchParams.get("project_id") === "project-1") return json([]);
    if (url.pathname === "/api/v1/specs") {
      return json({ id: "spec-1", filename: "API.md", status: "draft", current_version: "0.1.0" });
    }
    if (url.pathname === "/api/v1/specs/spec-1/publish") {
      return json({ id: "spec-1", filename: "API.md", status: "published", current_version: "1.0.0" });
    }
    throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
  }) as typeof fetch;

  try {
    await runSubmitDrafts({
      server: "https://specreg.example.com",
      type: "Web App Standard",
      dir: ".spec/drafts",
      author: "codex",
      delta: "minor",
      publish: true,
      force: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    process.chdir(originalCwd);
  }

  assert.match(logs.join("\n"), /Published newly created project-scoped spec/);
  assert.match(logs.join("\n"), /specreg sync/);
  assert.doesNotMatch(logs.join("\n"), /finish review, approval, and publication/);
});
