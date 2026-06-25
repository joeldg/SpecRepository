import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fetchJson } from "./registry.js";

export interface VerifyOptions {
  server: string;
  token?: string;
  dir: string;
  /** print nothing on success */
  quiet?: boolean;
}

export interface SignedManifest {
  project_type: string;
  specs: Array<{ filename: string; version: string; sha256?: string }>;
  signature?: string;
  signature_alg?: string;
  [key: string]: unknown;
}

export function verifyLocalSpecFiles(dir: string, manifest: SignedManifest): string[] {
  const problems: string[] = [];
  for (const entry of manifest.specs) {
    if (!entry.sha256) {
      problems.push(`${entry.filename}: manifest predates signing (re-run specreg sync)`);
      continue;
    }
    const filePath = path.join(dir, entry.filename);
    if (!fs.existsSync(filePath)) {
      problems.push(`${entry.filename}: file missing`);
      continue;
    }
    const actual = crypto.createHash("sha256").update(fs.readFileSync(filePath, "utf8"), "utf8").digest("hex");
    if (actual !== entry.sha256) {
      problems.push(`${entry.filename}: content hash mismatch (locally modified?)`);
    }
  }
  return problems;
}

/**
 * Verify local spec provenance: every file hash must match the manifest, and the
 * manifest signature must verify against the registry's ed25519 public key.
 */
export async function runVerify(opts: VerifyOptions): Promise<boolean> {
  const dir = path.resolve(process.cwd(), opts.dir);
  const manifestFile = path.join(dir, ".specregistry.json");
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`No manifest at ${manifestFile}. Run \`specreg init\` first.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as SignedManifest;

  const problems = verifyLocalSpecFiles(dir, manifest);

  if (!manifest.signature) {
    problems.push("manifest is unsigned (re-run specreg sync against a current server)");
  } else {
    // compile_targets is appended locally by `specreg compile` and is not part of the signed payload.
    const { signature, signature_alg: _alg, compile_targets: _local, ...payload } = manifest;
    const { public_key } = await fetchJson<{ public_key: string }>(
      `${opts.server}/api/v1/meta/public-key`,
      undefined,
      opts.token
    );
    const ok = crypto.verify(
      null,
      Buffer.from(JSON.stringify(payload), "utf8"),
      crypto.createPublicKey(public_key),
      Buffer.from(signature, "base64")
    );
    if (!ok) problems.push("manifest signature does not verify against the registry public key");
  }

  if (problems.length > 0) {
    console.error("Spec bundle verification FAILED:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return false;
  }
  if (!opts.quiet) {
    console.log(`Bundle verified: ${manifest.specs.length} file(s), signature OK (ed25519).`);
  }
  return true;
}
