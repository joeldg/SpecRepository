import fs from "node:fs";
import path from "node:path";
import type { SyncCheckResponse } from "@specregistry/shared";
import { fetchJson } from "./registry.js";
import { runInit } from "./init.js";
import { runCompile, savedCompileTargets } from "./compile.js";
import { runVerify } from "./verify.js";
import { repoIdentity, reportManifest, type Manifest } from "./repo.js";

export interface SyncOptions {
  server: string;
  token?: string;
  dir: string;
  /** check: report drift and exit 1; sync: re-pull when drift is found */
  mode: "check" | "sync";
  force?: boolean;
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

function savedSkillSelection(): string {
  const manifestPath = path.resolve(process.cwd(), ".spec/skills/manifest.json");
  if (!fs.existsSync(manifestPath)) return "base";
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { skills?: Array<{ slug?: string }> };
    const slugs = manifest.skills?.map((skill) => skill.slug).filter((slug): slug is string => Boolean(slug)) ?? [];
    return slugs.length ? slugs.join(",") : "none";
  } catch {
    return "base";
  }
}

export async function runSync(opts: SyncOptions): Promise<void> {
  const manifest = readManifest(opts.dir);
  const verified = await runVerify({ server: opts.server, token: opts.token, dir: opts.dir, quiet: true });
  if (!verified && opts.mode === "check") {
    console.error("\nLocal governed spec files do not match the signed registry manifest.");
    console.error("Run `specreg sync --force` if you intend to discard local edits and restore approved specs.");
    process.exit(1);
  }
  if (!verified && opts.mode === "sync" && !opts.force) {
    throw new Error("Local governed spec files do not match the signed registry manifest. Re-run `specreg sync --force` to restore approved specs.");
  }
  if (!verified && opts.mode === "sync" && opts.force) {
    console.log("\nLocal governed spec files do not match the signed registry manifest; restoring approved specs...");
    const compileTargets = savedCompileTargets(opts.dir);
    await runInit({
      server: opts.server,
      token: opts.token,
      type: manifest.project_type,
      dir: opts.dir,
      force: true,
      styleguides: "none",
      styleguideDir: ".spec/styleguides",
      skills: savedSkillSelection(),
      skillDir: ".spec/skills",
    });
    await runVerify({ server: opts.server, token: opts.token, dir: opts.dir, quiet: false });
    for (const target of compileTargets) {
      await runCompile({
        server: opts.server,
        token: opts.token,
        type: manifest.project_type,
        dir: opts.dir,
        target,
        force: true,
      });
    }
    return;
  }
  const identity = repoIdentity();
  const result = await fetchJson<SyncCheckResponse>(`${opts.server}/api/v1/cli/sync-check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_type: manifest.project_type, specs: manifest.specs, repo: identity.repo }),
  }, opts.token);
  try {
    await reportManifest(opts.server, opts.token, manifest, opts.dir, opts.mode);
  } catch (err) {
    console.log(`Could not report manifest usage: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`Project type: ${result.project_type}`);
  console.log(`  Up to date:     ${result.up_to_date.length}`);
  for (const file of result.outdated) {
    const pinNote = file.within_pin ? "" : "  ⚠ outside manifest pin (breaking change ahead)";
    console.log(
      `  OUTDATED (${file.severity}): ${file.filename}  ${file.local_version} -> ${file.latest_version}${pinNote}`
    );
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
  const compileTargets = savedCompileTargets(opts.dir);
  await runInit({
    server: opts.server,
    token: opts.token,
    type: manifest.project_type,
    dir: opts.dir,
    force: opts.force,
    styleguides: "none",
    styleguideDir: ".spec/styleguides",
    skills: savedSkillSelection(),
    skillDir: ".spec/skills",
  });
  await runVerify({ server: opts.server, token: opts.token, dir: opts.dir, quiet: false });
  for (const target of compileTargets) {
    await runCompile({
      server: opts.server,
      token: opts.token,
      type: manifest.project_type,
      dir: opts.dir,
      target,
      force: true,
    });
  }
}
