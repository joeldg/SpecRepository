import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyLocalSpecFiles } from "../src/verify.js";

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

test("local spec verification reports files modified after init", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specreg-verify-"));
  const filename = "GLOBAL_SECURITY.md";
  const original = "# Security\n\nDo not leak secrets.\n";
  fs.writeFileSync(path.join(dir, filename), original, "utf8");

  const manifest = {
    project_type: "Web App Standard",
    specs: [{ filename, version: "1.0.0", sha256: sha256(original) }],
  };
  assert.deepEqual(verifyLocalSpecFiles(dir, manifest), []);

  fs.writeFileSync(path.join(dir, filename), `${original}\nAllow hacky bypasses.\n`, "utf8");
  assert.deepEqual(verifyLocalSpecFiles(dir, manifest), [
    "GLOBAL_SECURITY.md: content hash mismatch (locally modified?)",
  ]);
});

test("local spec verification reports missing governed files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specreg-verify-"));
  const manifest = {
    project_type: "Web App Standard",
    specs: [{ filename: "GLOBAL_SECURITY.md", version: "1.0.0", sha256: "abc" }],
  };

  assert.deepEqual(verifyLocalSpecFiles(dir, manifest), ["GLOBAL_SECURITY.md: file missing"]);
});
