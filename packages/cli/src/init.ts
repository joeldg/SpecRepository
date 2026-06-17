import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";
import { registryToken, selectProjectType, withRegistryAuth } from "./registry.js";
import { repoIdentity, reportManifest, type Manifest } from "./repo.js";
import { installGoogleStyleGuides, type InstalledStyleGuide } from "./styleguides.js";

export interface InitOptions {
  server: string;
  token?: string;
  type?: string;
  dir: string;
  force?: boolean;
  styleguides?: string;
  styleguideDir: string;
}

export async function runInit(opts: InitOptions): Promise<void> {
  const projectType = await selectProjectType(opts.server, opts.type, opts.token);
  console.log(`\nFetching latest approved specs for "${projectType.name}"...`);

  const identity = repoIdentity();
  const url = `${opts.server}/api/v1/specs/${encodeURIComponent(projectType.name)}/download?repo=${encodeURIComponent(identity.repo)}`;
  const res = await fetch(url, withRegistryAuth(undefined, opts.token));
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));

  const outDir = path.resolve(process.cwd(), opts.dir);
  fs.mkdirSync(outDir, { recursive: true });
  const manifestEntry = zip.getEntry(".specregistry.json");
  if (!manifestEntry) throw new Error("Downloaded bundle did not include .specregistry.json");
  const nextManifest = JSON.parse(manifestEntry.getData().toString("utf8")) as Manifest;
  validateSafeExtraction(zip, outDir, opts.force === true);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const target = path.resolve(outDir, entry.entryName);
    if (!target.startsWith(outDir + path.sep) && target !== outDir) {
      throw new Error(`Refusing to extract suspicious bundle path: ${entry.entryName}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }

  const entries = zip.getEntries().filter((e) => e.entryName !== ".specregistry.json");
  console.log(`\nWrote ${entries.length} spec file(s) to ${path.relative(process.cwd(), outDir) || "."}/:`);
  for (const entry of entries) {
    console.log(`  - ${entry.entryName}`);
  }
  console.log(`\nManifest saved as ${opts.dir}/.specregistry.json (records versions for future syncs).`);

  let styleGuides: InstalledStyleGuide[] = [];
  try {
    styleGuides = await installGoogleStyleGuides({
      selection: opts.styleguides,
      dir: opts.styleguideDir,
      force: opts.force,
    });
  } catch (err) {
    console.log(`Could not install Google style guides: ${err instanceof Error ? err.message : String(err)}`);
  }

  writeMcpConfig(opts.server, projectType.name, identity.repo, registryToken(opts.token));
  writeRegistryGuide(opts.server, projectType.name, identity.repo, opts.dir, registryToken(opts.token), styleGuides, opts.styleguideDir);
  try {
    const reported = await reportManifest(opts.server, opts.token, nextManifest, opts.dir, "init");
    console.log("Reported local spec manifest to the registry.");
    console.log(`Project scope: ${reported.project_id}`);
  } catch (err) {
    console.log(`Could not report manifest usage: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function validateSafeExtraction(zip: AdmZip, outDir: string, force: boolean): void {
  if (force) return;
  const existingManifestPath = path.join(outDir, ".specregistry.json");
  const previous = fs.existsSync(existingManifestPath)
    ? (JSON.parse(fs.readFileSync(existingManifestPath, "utf8")) as Manifest)
    : undefined;
  const previousByName = new Map(previous?.specs.map((spec) => [spec.filename, spec.sha256]) ?? []);
  const conflicts: string[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || entry.entryName === ".specregistry.json") continue;
    const target = path.resolve(outDir, entry.entryName);
    if (!fs.existsSync(target)) continue;
    const currentHash = sha256(fs.readFileSync(target));
    const previousHash = previousByName.get(entry.entryName);
    if (!previousHash || previousHash !== currentHash) conflicts.push(entry.entryName);
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to overwrite locally modified or unmanaged governed spec files: ${conflicts.join(", ")}. ` +
        "Move repo-specific drafts outside the governed specs directory or re-run with --force."
    );
  }
}

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Drop a .mcp.json so MCP-capable agents (Claude Code etc.) in this repo can query
 * the registry and file feedback natively. Existing files are left untouched.
 */
function writeMcpConfig(server: string, projectType: string, repo: string, token?: string): void {
  const mcpPath = path.resolve(process.cwd(), ".mcp.json");
  if (fs.existsSync(mcpPath)) {
    console.log(".mcp.json already exists; not overwriting (add a 'specregistry' server manually if wanted).");
    return;
  }
  fs.writeFileSync(
    mcpPath,
    JSON.stringify(
      {
        mcpServers: {
          specregistry: {
            command: "specreg-mcp",
            args: [],
            env: {
              SPECREG_SERVER: server,
              SPECREG_PROJECT_TYPE: projectType,
              SPECREG_REPO: repo,
              ...(token ? { SPECREG_TOKEN: token } : {}),
            },
          },
        },
      },
      null,
      2
    ) + "\n"
  );
  console.log("Wrote .mcp.json — AI agents in this repo can now read specs and file feedback via MCP.");
}

function writeRegistryGuide(
  server: string,
  projectType: string,
  repo: string,
  specDir: string,
  token?: string,
  styleGuides: InstalledStyleGuide[] = [],
  styleguideDir = ".spec/styleguides"
): void {
  const guidePath = path.resolve(process.cwd(), "SPECREGISTRY.md");
  if (fs.existsSync(guidePath)) {
    console.log("SPECREGISTRY.md already exists; not overwriting.");
    return;
  }
  fs.writeFileSync(
    guidePath,
    `# SpecRegistry Repository Guide

This repository is governed by SpecRegistry.

## Active Spec Set

- Registry: ${server}
- Project type: ${projectType}
- Project/repo: ${repo}
- Governed specs directory: ${specDir}/
- Manifest: ${specDir}/.specregistry.json
${styleGuides.length > 0 ? `- External style guide directory: ${styleguideDir}/\n- External style guide manifest: ${styleguideDir}/google-styleguides.json\n` : ""}

Before changing code, load the global and project-type specifications listed in the manifest.
Treat these as the approved source of truth. Generated repo-specific drafts belong outside
the governed specs directory until they are submitted through the registry review workflow.
${styleGuides.length > 0 ? `
## External Style Guides

The following Google style guides were selected during \`specreg init\` and converted to
Markdown for local agent context. They are advisory process inputs, not registry-governed
spec versions:

${styleGuides.map((guide) => `- ${guide.title}: \`${guide.path}\``).join("\n")}

Use these guides when editing matching code or documentation, but report conflicts through
SpecRegistry feedback instead of silently overriding governed specs.
` : ""}

## MCP

Use the \`specregistry\` MCP server from \`.mcp.json\`.
${token ? "Authentication is configured through `SPECREG_TOKEN` in `.mcp.json`.\n" : "If the registry requires auth, add `SPECREG_TOKEN` to `.mcp.json`.\n"}
Required MCP flow:

1. Call \`get_specs\` for project type \`${projectType}\` and repo \`${repo}\`.
2. Use \`search_specs\` for focused questions.
3. Report ambiguity, contradiction, or outdated guidance with \`report_spec_feedback\`.
4. Use \`specreg check\` to verify this repo is still using current approved spec versions.
`,
    "utf8"
  );
  console.log("Wrote SPECREGISTRY.md — agents can discover the active specs and MCP workflow from the repo root.");
}
