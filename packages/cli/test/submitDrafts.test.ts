import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSubmitDrafts } from "../src/submitDrafts.js";

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function withMockedFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(new URL(String(input)), init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function withTempDraftDir(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specreg-submit-drafts-"));
  const draftDir = path.join(root, "specs");
  fs.mkdirSync(draftDir, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(draftDir, filename), content);
  }
  const originalCwd = process.cwd();
  process.chdir(root);
  return () => process.chdir(originalCwd);
}

function captureLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  return { logs, restore: () => (console.log = original) };
}

test("submit-drafts --publish skips the review reminder once everything is already published", async () => {
  const restoreCwd = withTempDraftDir({ "ONE.md": "# One\n\nContent.\n" });
  const restoreFetch = withMockedFetch((url) => {
    if (url.pathname === "/api/v1/project-types") {
      return response([{ id: "type-1", name: "Web App Standard", scope: "project_type", industry: null, description: null, created_at: "", updated_at: "" }]);
    }
    if (url.pathname === "/api/v1/cli/manifest-report") {
      return response({ project_id: "project-1" });
    }
    if (url.pathname === "/api/v1/specs" && url.search.includes("project_id=project-1")) {
      return response([]);
    }
    if (url.pathname === "/api/v1/specs") {
      return response({ id: "spec-1", status: "draft" }, { status: 201 });
    }
    if (url.pathname === "/api/v1/specs/spec-1/publish") {
      return response({ id: "spec-1", status: "published", current_version: "1.0.0" });
    }
    throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
  });
  const { logs, restore } = captureLogs();

  try {
    await runSubmitDrafts({
      server: "https://specreg.example.com",
      type: "Web App Standard",
      dir: "specs",
      author: "alice",
      delta: "minor",
      publish: true,
      force: false,
    });
  } finally {
    restore();
    restoreFetch();
    restoreCwd();
  }

  assert.ok(logs.some((line) => line.includes("(published 1.0.0)")));
  assert.ok(
    logs.some((line) => line.includes("already published") && line.includes("no further review action is needed")),
    `expected an "already published" summary line, got: ${JSON.stringify(logs)}`
  );
  assert.ok(!logs.some((line) => line.includes("Open the registry Reviews and Specs pages")));
});

test("submit-drafts still points at Reviews and Specs when a draft needs human review", async () => {
  const restoreCwd = withTempDraftDir({
    "ONE.md": "# One\n\nContent.\n",
    "TWO.md": "# Two\n\nUpdated content.\n",
  });
  const restoreFetch = withMockedFetch((url) => {
    if (url.pathname === "/api/v1/project-types") {
      return response([{ id: "type-1", name: "Web App Standard", scope: "project_type", industry: null, description: null, created_at: "", updated_at: "" }]);
    }
    if (url.pathname === "/api/v1/cli/manifest-report") {
      return response({ project_id: "project-1" });
    }
    if (url.pathname === "/api/v1/specs" && url.search.includes("project_id=project-1")) {
      return response([
        {
          id: "spec-two",
          project_type_id: "type-1",
          project_id: "project-1",
          filename: "TWO.md",
          current_version: "1.0.0",
          status: "published",
          updated_by: "alice",
          created_at: "",
          updated_at: "",
          project_type_name: "Web App Standard",
          project_type_scope: "project_type",
          project_name: "github.com/acme/app",
          effective_scope: "project",
          open_feedback_count: 0,
          pending_review_count: 0,
        },
      ]);
    }
    if (url.pathname === "/api/v1/specs") {
      return response({ id: "spec-1", status: "draft" }, { status: 201 });
    }
    if (url.pathname === "/api/v1/specs/review") {
      return response({ id: "cr-1", spec_id: "spec-two", status: "pending" }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
  });
  const { logs, restore } = captureLogs();

  try {
    await runSubmitDrafts({
      server: "https://specreg.example.com",
      type: "Web App Standard",
      dir: "specs",
      author: "alice",
      delta: "minor",
      publish: false,
      force: false,
    });
  } finally {
    restore();
    restoreFetch();
    restoreCwd();
  }

  assert.ok(logs.some((line) => line.includes("REVIEW:") && line.includes("cr-1")));
  assert.ok(logs.some((line) => line.includes("Open the registry Reviews and Specs pages")));
  assert.ok(!logs.some((line) => line.includes("no further review action is needed")));
});
