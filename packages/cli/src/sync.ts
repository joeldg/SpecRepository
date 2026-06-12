import fs from "node:fs";
import path from "node:path";
import type { SyncCheckResponse } from "@specregistry/shared";
import { fetchJson } from "./registry.js";
import { runInit } from "./init.js";

export interface SyncOptions {
  server: string;
  dir: string;
  /** check: report drift and exit 1; sync: re-pull when drift is found */
  mode: "check" | "sync";
}

interface Manifest {
  project_type: string;
  specs: Array<{ filename: string; version: string }>;
}

function readManifest(dir: string): Manifest {
  const manifestPath = path.resolve(process.cwd(), dir, ".specregistry.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `No manifest at ${manifestPath}. Run \`specreg init\` first to pull specs from the registry.`
    );
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
}

export async function runSync(opts: SyncOptions): Promise<void> {
  const manifest = readManifest(opts.dir);
  const result = await fetchJson<SyncCheckResponse>(`${opts.server}/api/v1/cli/sync-check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_type: manifest.project_type, specs: manifest.specs }),
  });

  console.log(`Project type: ${result.project_type}`);
  console.log(`  Up to date:     ${result.up_to_date.length}`);
  for (const file of result.outdated) {
    console.log(`  OUTDATED:       ${file.filename}  ${file.local_version} -> ${file.latest_version}`);
  }
  for (const file of result.missing_locally) {
    console.log(`  MISSING LOCAL:  ${file.filename}  (latest ${file.latest_version})`);
  }
  for (const filename of result.not_on_server) {
    console.log(`  LOCAL ONLY:     ${filename}  (not on the server)`);
  }

  if (!result.drift) {
    console.log("\nSpecs are in sync with the registry.");
    return;
  }

  if (opts.mode === "check") {
    console.error("\nSpec drift detected. Run `specreg sync` to update local specs.");
    process.exit(1);
  }

  console.log("\nDrift detected — pulling latest approved specs...");
  await runInit({ server: opts.server, type: manifest.project_type, dir: opts.dir });
}
